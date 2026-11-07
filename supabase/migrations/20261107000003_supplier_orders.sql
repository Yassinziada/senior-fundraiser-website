-- Supplier availability is separate from goods received. Only a manager can
-- confirm receipt; the receipt row, stock movement and audit commit together.
create table public.supplier_orders (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.profiles(id),
  title text not null check (length(trim(title)) between 1 and 120),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);
create table public.supplier_order_items (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.supplier_orders(id),
  product_id bigint not null references public.products(id),
  product_name text not null,
  quantity int not null check (quantity between 1 and 100000),
  available boolean not null default false,
  received int not null default 0 check (received >= 0 and received <= quantity),
  unique(order_id, product_id)
);
create table public.supplier_receipts (
  id uuid primary key, -- client-generated, retained for safe retry
  item_id bigint not null references public.supplier_order_items(id),
  quantity int not null check (quantity > 0),
  recorded_by uuid not null references public.profiles(id),
  recorded_at timestamptz not null default now()
);
create index supplier_orders_supplier_idx on public.supplier_orders(supplier_id, created_at desc);
create index supplier_order_items_order_idx on public.supplier_order_items(order_id);
alter table public.supplier_orders enable row level security;
alter table public.supplier_order_items enable row level security;
alter table public.supplier_receipts enable row level security;
revoke all on public.supplier_orders, public.supplier_order_items, public.supplier_receipts from anon, authenticated;
revoke all on sequence public.supplier_order_items_id_seq from anon, authenticated;
grant select on public.supplier_orders, public.supplier_order_items, public.supplier_receipts to authenticated;
create policy supplier_orders_read on public.supplier_orders for select to authenticated using (
  (select public.has_role(array['admin', 'product_manager'])) or
  (supplier_id = (select auth.uid()) and (select public.has_role(array['supplier'])))
);
create policy supplier_items_read on public.supplier_order_items for select to authenticated using (
  exists(select 1 from public.supplier_orders o where o.id = order_id)
);
create policy supplier_receipts_read on public.supplier_receipts for select to authenticated
  using ((select public.has_role(array['admin', 'product_manager'])));
create trigger supplier_receipts_immutable before update or delete on public.supplier_receipts
  for each row execute function public.forbid_change();

create or replace function public.create_supplier_order(p_id uuid, p_supplier uuid, p_title text, p_items jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_me public.profiles; v_order public.supplier_orders; r record; v_product public.products;
begin
  v_me := public._require_roles(array['admin', 'product_manager']);
  if p_id is null then perform public._fail('BAD_REQUEST', 'Missing list key.'); end if;
  perform pg_advisory_xact_lock(hashtextextended('supplier-order:' || p_id::text, 0));
  select * into v_order from public.supplier_orders where id = p_id;
  if found then
    if v_order.created_by <> v_me.id then perform public._fail('FORBIDDEN', 'List key already used.', '42501'); end if;
    return v_order.id;
  end if;
  if not exists(select 1 from public.profiles where id = p_supplier and active and role::text = 'supplier') then
    perform public._fail('BAD_REQUEST', 'Choose an active supplier.');
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 200 then
    perform public._fail('BAD_REQUEST', 'Include between 1 and 200 products.');
  end if;
  insert into public.supplier_orders(id, supplier_id, title, created_by)
    values(p_id, p_supplier, trim(p_title), v_me.id);
  perform 1 from public.products
    where id in (select (value->>'product_id')::bigint from jsonb_array_elements(p_items))
    order by id for share;
  for r in select value as item from jsonb_array_elements(p_items) loop
    if jsonb_typeof(r.item->'quantity') is distinct from 'number'
       or (r.item->>'quantity')::numeric <> trunc((r.item->>'quantity')::numeric) then
      perform public._fail('BAD_REQUEST', 'Quantity must be a whole number.');
    end if;
    select * into v_product from public.products where id = (r.item->>'product_id')::bigint;
    if not found or not v_product.active or not v_product.track_stock then
      perform public._fail('BAD_REQUEST', 'Lists require active, stock-tracked products.');
    end if;
    insert into public.supplier_order_items(order_id, product_id, product_name, quantity)
      values(p_id, v_product.id, v_product.name, (r.item->>'quantity')::int);
  end loop;
  perform public._audit('supplier_order_created', null, 'supplier_order', p_id::text,
    jsonb_build_object('supplier_id', p_supplier, 'title', trim(p_title)));
  return p_id;
end $$;

create or replace function public.supplier_set_available(p_item bigint, p_available boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_me public.profiles; v_item public.supplier_order_items;
begin
  v_me := public._require_roles(array['supplier']);
  select i.* into v_item from public.supplier_order_items i join public.supplier_orders o on o.id = i.order_id
    where i.id = p_item and o.supplier_id = v_me.id for update of i;
  if not found then perform public._fail('FORBIDDEN', 'Item not assigned to you.', '42501'); end if;
  if v_item.received = v_item.quantity then perform public._fail('BAD_REQUEST', 'This item has already been received.'); end if;
  if p_available is null then perform public._fail('BAD_REQUEST', 'Choose an availability.'); end if;
  update public.supplier_order_items set available = p_available where id = p_item;
  perform public._audit('supplier_availability_changed', null, 'supplier_order', v_item.order_id::text,
    jsonb_build_object('item_id', p_item, 'available', p_available));
end $$;

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
  if p_quantity > v_item.quantity - v_item.received then
    perform public._fail('BAD_QUANTITY', 'Quantity exceeds the remaining order.');
  end if;
  perform public.admin_adjust_stock(v_item.product_id, 'add', p_quantity,
    'Supplier receipt ' || p_key::text || ' for list ' || v_item.order_id::text);
  insert into public.supplier_receipts(id, item_id, quantity, recorded_by)
    values(p_key, p_item, p_quantity, v_me.id);
  update public.supplier_order_items set received = received + p_quantity where id = p_item;
  perform public._audit('supplier_goods_received', null, 'supplier_order', v_item.order_id::text,
    jsonb_build_object('receipt_id', p_key, 'item_id', p_item, 'quantity', p_quantity));
end $$;
revoke all on function public.create_supplier_order(uuid, uuid, text, jsonb),
  public.supplier_set_available(bigint, boolean), public.receive_supplier_item(uuid, bigint, int)
  from public, anon, authenticated;
grant execute on function public.create_supplier_order(uuid, uuid, text, jsonb),
  public.supplier_set_available(bigint, boolean), public.receive_supplier_item(uuid, bigint, int) to authenticated;
