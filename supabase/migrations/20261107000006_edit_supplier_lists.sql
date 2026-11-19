begin;

create function public.add_supplier_order_item(p_key uuid, p_order uuid, p_product bigint, p_quantity int)
returns void language plpgsql security definer set search_path = '' as $$
declare v_me public.profiles; v_product public.products; v_item bigint; v_details jsonb;
begin
  v_me := public._require_roles(array['admin', 'product_manager']);
  if p_key is null or p_quantity is null or p_quantity not between 1 and 100000 then
    perform public._fail('BAD_REQUEST', 'Enter a whole quantity between 1 and 100000.');
  end if;
  -- Serialize additions to this list so the product limit holds across sessions.
  perform 1 from public.supplier_orders where id = p_order for update;
  if not found then perform public._fail('NOT_FOUND', 'Supplier list not found.'); end if;
  v_details := jsonb_build_object('key', p_key, 'product_id', p_product, 'quantity', p_quantity);
  if exists (
    select 1 from public.audit_logs where action = 'supplier_order_item_added'
      and actor_id = v_me.id and entity_id = p_order::text and details @> v_details
  ) then return; end if;

  if exists (select 1 from public.supplier_order_items where order_id = p_order and product_id = p_product) then
    perform public._fail('BAD_REQUEST', 'This product is already on the list.');
  end if;
  if (select count(*) from public.supplier_order_items where order_id = p_order) >= 200 then
    perform public._fail('BAD_REQUEST', 'A supplier list can include up to 200 products.');
  end if;
  select * into v_product from public.products where id = p_product for share;
  if not found or not v_product.active or not v_product.track_stock then
    perform public._fail('BAD_REQUEST', 'Lists require active, stock-tracked products.');
  end if;
  insert into public.supplier_order_items(order_id, product_id, product_name, quantity)
    values(p_order, v_product.id, v_product.name, p_quantity) returning id into v_item;
  perform public._audit('supplier_order_item_added', null, 'supplier_order', p_order::text,
    v_details || jsonb_build_object('item_id', v_item));
end $$;

create function public.remove_supplier_order_item(p_order uuid, p_item bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare v_item public.supplier_order_items;
begin
  perform public._require_roles(array['admin', 'product_manager']);
  select * into v_item from public.supplier_order_items where order_id = p_order and id = p_item for update;
  if not found then return; end if;
  if v_item.purchased > 0 then
    perform public._fail('BAD_REQUEST', 'This product already has a confirmed purchase or receipt.');
  end if;
  delete from public.supplier_order_items where id = p_item;
  perform public._audit('supplier_order_item_removed', null, 'supplier_order', p_order::text,
    jsonb_build_object('item_id', p_item, 'product_id', v_item.product_id, 'quantity', v_item.quantity));
end $$;

revoke all on function public.add_supplier_order_item(uuid, uuid, bigint, int),
  public.remove_supplier_order_item(uuid, bigint) from public, anon, authenticated;
grant execute on function public.add_supplier_order_item(uuid, uuid, bigint, int),
  public.remove_supplier_order_item(uuid, bigint) to authenticated;

notify pgrst, 'reload schema';
commit;
