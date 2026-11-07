-- Run once after the supplier-orders migration. Existing stock and receipts
-- are preserved; historical receipts are not treated as supplier confirmations.
begin;

alter table public.supplier_order_items
  add column purchased int not null default 0,
  add column delivered int not null default 0,
  add column purchased_at timestamptz,
  add column purchased_by uuid references public.profiles(id),
  add column delivered_at timestamptz,
  add column delivered_by uuid references public.profiles(id);

-- Preserve the already accepted historical quantity without asserting that
-- a supplier confirmed it. Any further receipt needs explicit confirmations.
update public.supplier_order_items
  set purchased = received, delivered = received
  where received > 0;

alter table public.supplier_order_items
  add constraint supplier_item_fulfillment_quantities check (
    received <= delivered and delivered <= purchased
    and purchased <= quantity and delivered >= 0 and purchased >= 0
  ),
  add constraint supplier_item_purchase_actor check (
    (purchased_at is null) = (purchased_by is null)
  ),
  add constraint supplier_item_delivery_actor check (
    (delivered_at is null) = (delivered_by is null)
  );

-- Legacy availability data remains for history, but cannot drive the workflow.
revoke all on function public.supplier_set_available(bigint, boolean)
  from public, anon, authenticated;

create or replace function public._supplier_confirm_quantity(
  p_item bigint, p_quantity int, p_stage text
) returns void language plpgsql security definer set search_path = '' as $$
declare v_me public.profiles; v_item public.supplier_order_items; v_previous int;
begin
  v_me := public._require_roles(array['supplier']);
  select i.* into v_item from public.supplier_order_items i
    join public.supplier_orders o on o.id = i.order_id
    where i.id = p_item and o.supplier_id = v_me.id for update of i;
  if not found then
    perform public._fail('FORBIDDEN', 'Item not assigned to you.', '42501');
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > v_item.quantity then
    perform public._fail('BAD_QUANTITY', 'Enter a positive whole total no greater than the requested quantity.');
  end if;

  if p_stage = 'purchase' then
    v_previous := v_item.purchased;
    if p_quantity < v_previous then
      perform public._fail('BAD_QUANTITY', 'Purchased total cannot decrease. Contact the manager if a correction is needed.');
    end if;
    if p_quantity = v_previous and v_item.purchased_at is not null then return; end if;
    update public.supplier_order_items
      set purchased = p_quantity, purchased_at = now(), purchased_by = v_me.id
      where id = p_item;
  elsif p_stage = 'delivery' then
    v_previous := v_item.delivered;
    if v_item.purchased_at is null then
      perform public._fail('PURCHASE_REQUIRED', 'Confirm how many items you bought before confirming delivery.');
    end if;
    if p_quantity > v_item.purchased or p_quantity < v_previous then
      perform public._fail('BAD_QUANTITY', 'Delivered total must not decrease or exceed the confirmed purchased total.');
    end if;
    if p_quantity = v_previous and v_item.delivered_at is not null then return; end if;
    update public.supplier_order_items
      set delivered = p_quantity, delivered_at = now(), delivered_by = v_me.id
      where id = p_item;
  else
    perform public._fail('BAD_REQUEST', 'Unknown supplier confirmation.');
  end if;
  perform public._audit(
    case when p_stage = 'purchase' then 'supplier_purchase_confirmed' else 'supplier_delivery_confirmed' end,
    null, 'supplier_order', v_item.order_id::text,
    jsonb_build_object('item_id', p_item, 'previous_total', v_previous, 'confirmed_total', p_quantity)
  );
end $$;

create or replace function public.supplier_confirm_purchase(p_item bigint, p_quantity int)
returns void language sql security definer set search_path = '' as $$
  select public._supplier_confirm_quantity(p_item, p_quantity, 'purchase');
$$;
create or replace function public.supplier_confirm_delivery(p_item bigint, p_quantity int)
returns void language sql security definer set search_path = '' as $$
  select public._supplier_confirm_quantity(p_item, p_quantity, 'delivery');
$$;

revoke all on function public._supplier_confirm_quantity(bigint, int, text),
  public.supplier_confirm_purchase(bigint, int), public.supplier_confirm_delivery(bigint, int)
  from public, anon, authenticated;
grant execute on function public.supplier_confirm_purchase(bigint, int),
  public.supplier_confirm_delivery(bigint, int) to authenticated;

create or replace function public.receive_supplier_item(p_key uuid, p_item bigint, p_quantity int)
returns void language plpgsql security definer set search_path = '' as $$
declare v_me public.profiles; v_item public.supplier_order_items; v_prev public.supplier_receipts;
begin
  v_me := public._require_roles(array['admin', 'product_manager']);
  if p_key is null or p_quantity is null or p_quantity < 1 then
    perform public._fail('BAD_REQUEST', 'Enter a positive whole received quantity.');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('supplier-receipt:' || p_key::text, 0));
  select * into v_prev from public.supplier_receipts where id = p_key;
  if found then
    if v_prev.item_id <> p_item or v_prev.quantity <> p_quantity or v_prev.recorded_by <> v_me.id then
      perform public._fail('BAD_REQUEST', 'Receipt key already used for a different receipt.');
    end if;
    return;
  end if;
  select * into v_item from public.supplier_order_items where id = p_item for update;
  if not found then perform public._fail('NOT_FOUND', 'List item not found.'); end if;
  if v_item.purchased_at is null or v_item.delivered_at is null then
    perform public._fail('DELIVERY_REQUIRED', 'The supplier must confirm purchase and delivery before stock can be received.');
  end if;
  if p_quantity > v_item.delivered - v_item.received then
    perform public._fail('BAD_QUANTITY', 'Quantity exceeds supplier-confirmed delivery awaiting receipt.');
  end if;
  perform public.admin_adjust_stock(v_item.product_id, 'add', p_quantity,
    'Supplier receipt ' || p_key::text || ' for list ' || v_item.order_id::text);
  insert into public.supplier_receipts(id, item_id, quantity, recorded_by)
    values(p_key, p_item, p_quantity, v_me.id);
  update public.supplier_order_items set received = received + p_quantity where id = p_item;
  perform public._audit('supplier_goods_received', null, 'supplier_order', v_item.order_id::text,
    jsonb_build_object('receipt_id', p_key, 'item_id', p_item, 'quantity', p_quantity));
end $$;

insert into public.audit_logs(actor_name, actor_role, action, entity_type, details)
  select 'Supplier workflow migration', 'system', 'supplier_workflow_upgraded', 'supplier_order',
    jsonb_build_object('historical_received_items', count(*), 'historical_received_quantity', coalesce(sum(received), 0))
  from public.supplier_order_items where received > 0;

notify pgrst, 'reload schema';
commit;
