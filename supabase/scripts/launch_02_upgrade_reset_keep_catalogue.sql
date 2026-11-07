-- STEP 2: OLD LIVE project bpyqftcwmikfrqfpsemz ONLY.
-- DESTRUCTIVE, user-approved prelaunch reset. Close all POS tabs first.
-- KEEP: products, categories, prices, costs, image URLs, settings, sections,
--       and the existing active Admin yassinziada@gmail.com (same password).
-- CLEAR: all stock quantities, sales, voids, cash handovers, money/opening,
--        supplier lists, old audit records and every OTHER Auth account/profile.
-- Does NOT touch Storage files, so catalogue images remain available.
-- One transaction: errors roll back the upgrade and reset together.
-- Refuses to run a second time; never rerun for a future event.
-- This script must run as the SQL Editor database owner, never through the app.
begin;
set local lock_timeout='15s';
set local statement_timeout='120s';

-- Verify the one account we must preserve before changing anything.
do $preflight$
begin
 if not exists(select 1 from auth.users u join public.profiles p on p.id=u.id
  where lower(u.email)='yassinziada@gmail.com' and p.role='admin' and p.active) then
  raise exception 'STOP: active Admin yassinziada@gmail.com was not found in this project. No data was changed.';
 end if;
 if exists(select 1 from public.audit_logs where action='fundraiser_prelaunch_reset'
  and details->>'reset_id'='live-launch-2026-11-07') then
  raise exception 'STOP: this launch reset already ran. It will not erase new fundraiser data.';
 end if;
 if not exists(select 1 from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typnamespace='public'::regnamespace and t.typname='app_role' and e.enumlabel='supplier') then
  raise exception 'Run launch_01_roles.sql separately first.';
 end if;
end $preflight$;


do $upgrade$ begin if to_regprocedure('public.has_role(text[])') is null then execute $migration$
-- Staff capabilities. is_admin() remains strictly administrator-only.
create or replace function public.has_role(p_roles text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role::text = any(p_roles));
$$;
create or replace function public._require_roles(p_roles text[])
returns public.profiles language plpgsql stable security definer set search_path = '' as $$
declare v public.profiles;
begin
  v := public._me();
  if not (v.role::text = any(p_roles)) then
    perform public._fail('FORBIDDEN', 'Your role cannot perform this action.', '42501');
  end if;
  return v;
end $$;
revoke all on function public.has_role(text[]), public._require_roles(text[]) from public, anon, authenticated;
grant execute on function public.has_role(text[]) to authenticated;

alter table public.profiles add constraint profiles_staff_no_section
  check (role::text in ('admin', 'cashier') or section_code is null);
create policy sections_staff on public.sections for select to authenticated
  using ((select public.has_role(array['finance', 'product_manager'])));
create policy settings_staff on public.app_settings for select to authenticated
  using ((select public.has_role(array['finance', 'product_manager', 'supplier'])));
create policy profiles_finance on public.profiles for select to authenticated
  using ((select public.has_role(array['finance'])));
create policy profiles_suppliers on public.profiles for select to authenticated
  using (role::text = 'supplier' and (select public.has_role(array['product_manager'])));
create policy products_staff on public.products for select to authenticated using ((select public.has_role(array['finance', 'product_manager'])));
create policy categories_staff on public.categories for select to authenticated using ((select public.has_role(array['finance', 'product_manager'])));
create policy product_costs_staff on public.product_costs for select to authenticated using ((select public.has_role(array['finance', 'product_manager'])));
create policy stock_movements_staff on public.stock_movements for select to authenticated using ((select public.has_role(array['finance', 'product_manager'])));
create policy transactions_finance on public.transactions for select to authenticated using ((select public.has_role(array['finance'])));
create policy transaction_items_finance on public.transaction_items for select to authenticated using ((select public.has_role(array['finance'])));
create policy void_requests_finance on public.void_requests for select to authenticated using ((select public.has_role(array['finance'])));
create policy cash_handovers_finance on public.cash_handovers for select to authenticated using ((select public.has_role(array['finance'])));

create or replace function public.admin_save_product(p jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_me       public.profiles;
  v_old      public.products;
  v_old_cost numeric(12,2);
  v_id       bigint := nullif(p ->> 'id', '')::bigint;
  v_section  text := p ->> 'section_code';
  v_cat      bigint := nullif(p ->> 'category_id', '')::bigint;
  v_name     text := trim(coalesce(p ->> 'name', ''));
  v_sku      text := nullif(trim(coalesce(p ->> 'sku', '')), '');
  v_price    numeric(12,2) := (p ->> 'price')::numeric;
  v_cost     numeric(12,2) := coalesce(nullif(p ->> 'cost', '')::numeric, 0);
  v_image    text := nullif(trim(coalesce(p ->> 'image_url', '')), '');
  v_track    boolean := coalesce((p ->> 'track_stock')::boolean, true);
  v_start    int := coalesce(nullif(p ->> 'starting_stock', '')::int, 0);
  v_min      int := nullif(p ->> 'min_stock', '')::int;
  v_active   boolean := coalesce((p ->> 'active')::boolean, true);
  v_changes  jsonb := '{}'::jsonb;
begin
  v_me := public._require_roles(array['admin', 'product_manager']);
  if v_name = '' then perform public._fail('BAD_REQUEST', 'Product name is required.'); end if;
  if v_price is null or v_price < 0 then perform public._fail('BAD_REQUEST', 'Selling price must be 0 or more.'); end if;
  if v_cost < 0 then perform public._fail('BAD_REQUEST', 'Cost must be 0 or more.'); end if;
  if v_start < 0 then perform public._fail('BAD_REQUEST', 'Starting stock must be 0 or more.'); end if;
  if v_min is null then
    select low_stock_default into v_min from public.app_settings where id = 1;
  end if;
  if v_min < 0 then perform public._fail('BAD_REQUEST', 'Minimum stock must be 0 or more.'); end if;
  if not exists (select 1 from public.sections where code = v_section) then
    perform public._fail('BAD_REQUEST', 'Choose a valid section.');
  end if;
  if v_cat is not null and not exists (select 1 from public.categories where id = v_cat and section_code = v_section) then
    perform public._fail('BAD_REQUEST', 'That category belongs to a different section.');
  end if;
  if not v_track then v_start := 0; v_min := 0; end if;
  if v_sku is not null and exists (select 1 from public.products where sku = v_sku and id is distinct from v_id) then
    perform public._fail('DUPLICATE', format('The code "%s" is already used by another product.', v_sku));
  end if;

  if v_id is null then
    if exists (select 1 from public.products where section_code = v_section and lower(name) = lower(v_name)) then
      perform public._fail('DUPLICATE', format('A product called "%s" already exists in this section.', v_name));
    end if;
    insert into public.products (sku, section_code, category_id, name, price, image_url, track_stock,
      starting_stock, stock, min_stock, active)
    values (v_sku, v_section, v_cat, v_name, v_price, v_image, v_track, v_start, v_start, v_min, v_active)
    returning id into v_id;
    insert into public.product_costs (product_id, cost) values (v_id, v_cost);
    if v_start > 0 then
      insert into public.stock_movements (product_id, section_code, movement_type, quantity_change,
        stock_before, stock_after, created_by, reason)
      values (v_id, v_section, 'initial', v_start, 0, v_start, v_me.id, 'Starting stock');
    end if;
    perform public._audit('product_created', v_section, 'product', v_id::text,
      jsonb_build_object('name', v_name, 'price', v_price, 'cost', v_cost, 'starting_stock', v_start,
        'min_stock', v_min, 'category_id', v_cat, 'track_stock', v_track, 'active', v_active));
    return v_id;
  end if;

  -- update
  select * into v_old from public.products where id = v_id for update;
  if not found then perform public._fail('NOT_FOUND', 'Product not found.'); end if;
  select cost into v_old_cost from public.product_costs where product_id = v_id;
  if v_track <> v_old.track_stock and v_old.stock <> 0 then
    perform public._fail('BAD_REQUEST', 'Remove all stock (set it to 0 with a stock adjustment) before changing stock tracking.');
  end if;
  if exists (select 1 from public.products where section_code = v_section and lower(name) = lower(v_name) and id <> v_id) then
    perform public._fail('DUPLICATE', format('A product called "%s" already exists in this section.', v_name));
  end if;

  if v_old.name is distinct from v_name then v_changes := v_changes || jsonb_build_object('name', jsonb_build_array(v_old.name, v_name)); end if;
  if v_old.sku is distinct from v_sku then v_changes := v_changes || jsonb_build_object('sku', jsonb_build_array(v_old.sku, v_sku)); end if;
  if v_old.section_code is distinct from v_section then v_changes := v_changes || jsonb_build_object('section_code', jsonb_build_array(v_old.section_code, v_section)); end if;
  if v_old.category_id is distinct from v_cat then v_changes := v_changes || jsonb_build_object('category_id', jsonb_build_array(v_old.category_id, v_cat)); end if;
  if v_old.image_url is distinct from v_image then v_changes := v_changes || jsonb_build_object('image_url', jsonb_build_array(v_old.image_url, v_image)); end if;
  if v_old.track_stock is distinct from v_track then v_changes := v_changes || jsonb_build_object('track_stock', jsonb_build_array(v_old.track_stock, v_track)); end if;
  if v_old.min_stock is distinct from v_min then v_changes := v_changes || jsonb_build_object('min_stock', jsonb_build_array(v_old.min_stock, v_min)); end if;
  if v_old.active is distinct from v_active then v_changes := v_changes || jsonb_build_object('active', jsonb_build_array(v_old.active, v_active)); end if;

  -- starting_stock / stock are NOT editable here: stock changes only through
  -- sales, voids and admin_adjust_stock (which require a reason).
  update public.products
     set sku = v_sku, section_code = v_section, category_id = v_cat, name = v_name, price = v_price,
         image_url = v_image, track_stock = v_track, min_stock = v_min, active = v_active
   where id = v_id;
  update public.product_costs set cost = v_cost where product_id = v_id;

  if v_old.price <> v_price then
    perform public._audit('price_changed', v_section, 'product', v_id::text,
      jsonb_build_object('name', v_name, 'from', v_old.price, 'to', v_price));
  end if;
  if v_old_cost is distinct from v_cost then
    perform public._audit('cost_changed', v_section, 'product', v_id::text,
      jsonb_build_object('name', v_name, 'from', v_old_cost, 'to', v_cost));
  end if;
  if v_changes <> '{}'::jsonb then
    perform public._audit(case when v_changes ? 'active' and (select count(*) from jsonb_object_keys(v_changes)) = 1
                               then case when v_active then 'product_activated' else 'product_deactivated' end
                               else 'product_updated' end,
      v_section, 'product', v_id::text, jsonb_build_object('name', v_name, 'changes', v_changes));
  end if;
  return v_id;
end $$;

create or replace function public.admin_set_product_active(p_product_id bigint, p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.products;
begin
  perform public._require_roles(array['admin', 'product_manager']);
  select * into v from public.products where id = p_product_id for update;
  if not found then perform public._fail('NOT_FOUND', 'Product not found.'); end if;
  if v.active = p_active then return; end if;
  update public.products set active = p_active where id = p_product_id;
  perform public._audit(case when p_active then 'product_activated' else 'product_deactivated' end,
    v.section_code, 'product', v.id::text, jsonb_build_object('name', v.name));
end $$;

create or replace function public.admin_adjust_stock(p_product_id bigint, p_mode text, p_quantity int, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me    public.profiles;
  v     public.products;
  v_delta int;
  v_after int;
begin
  v_me := public._require_roles(array['admin', 'product_manager']);
  if length(trim(coalesce(p_reason, ''))) < 3 then
    perform public._fail('REASON_REQUIRED', 'A reason is required for every stock adjustment (at least 3 characters).');
  end if;
  if p_quantity is null or p_quantity < 0 then
    perform public._fail('BAD_QUANTITY', 'Quantity must be 0 or more.');
  end if;
  select * into v from public.products where id = p_product_id for update;
  if not found then perform public._fail('NOT_FOUND', 'Product not found.'); end if;
  if not v.track_stock then
    perform public._fail('BAD_REQUEST', 'This product does not track stock (service).');
  end if;

  v_delta := case p_mode
    when 'add' then p_quantity
    when 'remove' then -p_quantity
    when 'set' then p_quantity - v.stock
  end;
  if v_delta is null then perform public._fail('BAD_REQUEST', 'Mode must be add, remove or set.'); end if;
  if v_delta = 0 then perform public._fail('NO_CHANGE', 'Nothing to change: the stock is already at that level.'); end if;
  if v.stock + v_delta < 0 then
    perform public._fail('INSUFFICIENT_STOCK', format('Cannot remove %s: only %s in stock.', -v_delta, v.stock));
  end if;

  update public.products set stock = stock + v_delta where id = v.id returning stock into v_after;
  insert into public.stock_movements (product_id, section_code, movement_type, quantity_change, stock_before,
    stock_after, created_by, reason)
  values (v.id, v.section_code, case when v_delta > 0 then 'adjust_add' else 'adjust_remove' end::public.stock_movement_type,
    v_delta, v.stock, v_after, v_me.id, trim(p_reason));
  perform public._audit('stock_adjusted', v.section_code, 'product', v.id::text,
    jsonb_build_object('name', v.name, 'mode', p_mode, 'change', v_delta, 'from', v.stock, 'to', v_after, 'reason', trim(p_reason)));
  return jsonb_build_object('product_id', v.id, 'stock', v_after, 'change', v_delta);
end $$;

create or replace function public.admin_save_category(
  p_id bigint, p_section text, p_name text, p_sort_order int default 0, p_active boolean default true
) returns bigint language plpgsql security definer set search_path = '' as $$
declare v_old public.categories; v_id bigint; v_name text := trim(coalesce(p_name, ''));
begin
  perform public._require_roles(array['admin', 'product_manager']);
  if v_name = '' then perform public._fail('BAD_REQUEST', 'Category name is required.'); end if;
  if p_id is null then
    if not exists (select 1 from public.sections where code = p_section) then
      perform public._fail('BAD_REQUEST', 'Choose a valid section.');
    end if;
    if exists (select 1 from public.categories where section_code = p_section and lower(name) = lower(v_name)) then
      perform public._fail('DUPLICATE', 'That category already exists in this section.');
    end if;
    insert into public.categories (section_code, name, sort_order, active)
    values (p_section, v_name, coalesce(p_sort_order, 0), coalesce(p_active, true)) returning id into v_id;
    perform public._audit('category_created', p_section, 'category', v_id::text, jsonb_build_object('name', v_name));
    return v_id;
  end if;
  select * into v_old from public.categories where id = p_id for update;
  if not found then perform public._fail('NOT_FOUND', 'Category not found.'); end if;
  if exists (select 1 from public.categories where section_code = v_old.section_code and lower(name) = lower(v_name) and id <> p_id) then
    perform public._fail('DUPLICATE', 'That category already exists in this section.');
  end if;
  update public.categories set name = v_name, sort_order = coalesce(p_sort_order, sort_order),
    active = coalesce(p_active, active) where id = p_id;
  perform public._audit('category_updated', v_old.section_code, 'category', p_id::text,
    jsonb_build_object('from', jsonb_build_object('name', v_old.name, 'sort_order', v_old.sort_order, 'active', v_old.active),
                       'to', jsonb_build_object('name', v_name, 'sort_order', p_sort_order, 'active', p_active)));
  return p_id;
end $$;

create or replace function public.admin_import_products(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb; v_cat bigint; v_created int := 0; v_cats int := 0; v_skipped jsonb := '[]'::jsonb;
  v_section text; v_catname text;
begin
  perform public._require_roles(array['admin', 'product_manager']);
  if jsonb_typeof(p_rows) is distinct from 'array' then perform public._fail('BAD_REQUEST', 'Expected a list of products.'); end if;
  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_section := v_row ->> 'section_code';
    v_catname := nullif(trim(coalesce(v_row ->> 'category', '')), '');
    if exists (select 1 from public.products where section_code = v_section and lower(name) = lower(trim(v_row ->> 'name'))) then
      v_skipped := v_skipped || to_jsonb(v_row ->> 'name');
      continue;
    end if;
    v_cat := null;
    if v_catname is not null then
      select id into v_cat from public.categories where section_code = v_section and lower(name) = lower(v_catname);
      if v_cat is null then
        v_cat := public.admin_save_category(null, v_section, v_catname, 0, true);
        v_cats := v_cats + 1;
      end if;
    end if;
    perform public.admin_save_product(jsonb_build_object(
      'section_code', v_section, 'category_id', v_cat, 'name', v_row ->> 'name',
      -- keep the old code unless another product already uses it
      'sku', case when exists (select 1 from public.products where sku = v_row ->> 'sku') then null else v_row ->> 'sku' end,
      'price', v_row -> 'price', 'cost', coalesce(v_row -> 'cost', '0'::jsonb), 'image_url', v_row ->> 'image_url',
      'track_stock', coalesce(v_row -> 'track_stock', 'true'::jsonb),
      'starting_stock', coalesce(v_row -> 'stock', '0'::jsonb), 'min_stock', v_row -> 'min_stock',
      'active', coalesce(v_row -> 'active', 'true'::jsonb)));
    v_created := v_created + 1;
  end loop;
  perform public._audit('products_imported', null, 'product', null,
    jsonb_build_object('created', v_created, 'categories_created', v_cats, 'skipped', v_skipped));
  return jsonb_build_object('created', v_created, 'categories_created', v_cats, 'skipped', v_skipped);
end $$;

create or replace function public.admin_products_overview(p_section text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require_roles(array['admin', 'finance', 'product_manager']);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id, 'sku', p.sku, 'section_code', p.section_code, 'category_id', p.category_id,
      'category_name', c.name, 'name', p.name, 'price', p.price, 'cost', coalesce(pc.cost, 0),
      'profit_per_item', p.price - coalesce(pc.cost, 0),
      'margin_pct', case when p.price > 0 then round((p.price - coalesce(pc.cost, 0)) / p.price * 100, 1) end,
      'image_url', p.image_url, 'track_stock', p.track_stock, 'starting_stock', p.starting_stock,
      'stock', p.stock, 'min_stock', p.min_stock, 'active', p.active,
      'sold_qty', coalesce(s.qty, 0), 'sold_revenue', case when public.has_role(array['admin', 'finance']) then coalesce(s.revenue, 0) end,
      'created_at', p.created_at, 'updated_at', p.updated_at
    ) order by p.section_code, c.sort_order nulls last, c.name nulls last, p.name)
    from public.products p
    left join public.categories c on c.id = p.category_id
    left join public.product_costs pc on pc.product_id = p.id
    left join (
      select i.product_id, sum(i.quantity) as qty, sum(i.line_total) as revenue
      from public.transaction_items i join public.transactions t on t.id = i.transaction_id
      where t.status = 'completed' group by i.product_id
    ) s on s.product_id = p.id
    where p_section is null or p.section_code = p_section
  ), '[]'::jsonb);
end $$;

create or replace function public.admin_inventory_summary(p_section text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform public._require_roles(array['admin', 'finance', 'product_manager']);
  with p as (
    select p.*, coalesce(pc.cost, 0) as cost, c.name as category_name
    from public.products p
    left join public.product_costs pc on pc.product_id = p.id
    left join public.categories c on c.id = p.category_id
    where p_section is null or p.section_code = p_section
  )
  select jsonb_build_object(
    'product_count', (select count(*) from p),
    'active_count', (select count(*) from p where active),
    'units_in_stock', (select coalesce(sum(stock), 0) from p where track_stock),
    'stock_cost_value', (select coalesce(sum(stock * cost), 0) from p where track_stock),
    'stock_retail_value', (select coalesce(sum(stock * price), 0) from p where track_stock),
    'low_stock', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'section_code', section_code,
        'category_name', category_name, 'stock', stock, 'min_stock', min_stock) order by stock, name)
      from p where active and track_stock and stock > 0 and stock <= min_stock), '[]'::jsonb),
    'out_of_stock', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'section_code', section_code,
        'category_name', category_name, 'stock', stock, 'min_stock', min_stock) order by name)
      from p where active and track_stock and stock = 0), '[]'::jsonb),
    'by_section', coalesce((select jsonb_agg(jsonb_build_object('section_code', section_code, 'units', units,
        'cost_value', cost_value, 'retail_value', retail_value) order by section_code)
      from (select section_code, sum(stock) as units, sum(stock * cost) as cost_value, sum(stock * price) as retail_value
            from p where track_stock group by 1) q), '[]'::jsonb)
  ) into v;
  return v;
end $$;

create or replace function public.admin_sales_report(p_from date, p_to date, p_section text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform public._require_roles(array['admin', 'finance']);
  with
  t_all as (
    select t.* from public.transactions t
    where t.business_date between p_from and p_to
      and (p_section is null or t.section_code = p_section)
  ),
  t_ok as (select * from t_all where status = 'completed'),
  li as (
    select i.*, t.business_date, t.cashier_id
    from public.transaction_items i join t_ok t on t.id = i.transaction_id
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'section', p_section,
    'totals', (
      select jsonb_build_object(
        'revenue', coalesce(sum(total), 0),
        'transactions', count(*),
        'units', coalesce(sum(item_count), 0),
        'avg_transaction', case when count(*) > 0 then round(sum(total) / count(*), 2) else 0 end,
        'cogs', coalesce(sum(total_cost), 0),
        'gross_profit', coalesce(sum(total) - sum(total_cost), 0),
        'margin_pct', case when sum(total) > 0 then round((sum(total) - sum(total_cost)) / sum(total) * 100, 1) end,
        'cash', coalesce(sum(total) filter (where payment_method = 'CASH'), 0),
        'telda', coalesce(sum(total) filter (where payment_method = 'TELDA'), 0),
        'instapay', coalesce(sum(total) filter (where payment_method = 'INSTAPAY'), 0),
        'voided_count', (select count(*) from t_all where status = 'voided'),
        'voided_amount', (select coalesce(sum(total), 0) from t_all where status = 'voided')
      ) from t_ok),
    'by_section', coalesce((
      select jsonb_agg(x order by x ->> 'section_code') from (
        select jsonb_build_object(
          'section_code', s.code, 'section_name', s.name,
          'revenue', coalesce(sum(t.total) filter (where t.status = 'completed'), 0),
          'transactions', count(t.id) filter (where t.status = 'completed'),
          'units', coalesce(sum(t.item_count) filter (where t.status = 'completed'), 0),
          'cogs', coalesce(sum(t.total_cost) filter (where t.status = 'completed'), 0),
          'gross_profit', coalesce(sum(t.total - t.total_cost) filter (where t.status = 'completed'), 0),
          'cash', coalesce(sum(t.total) filter (where t.status = 'completed' and t.payment_method = 'CASH'), 0),
          'telda', coalesce(sum(t.total) filter (where t.status = 'completed' and t.payment_method = 'TELDA'), 0),
          'instapay', coalesce(sum(t.total) filter (where t.status = 'completed' and t.payment_method = 'INSTAPAY'), 0),
          'voided_count', count(t.id) filter (where t.status = 'voided'),
          'voided_amount', coalesce(sum(t.total) filter (where t.status = 'voided'), 0)
        ) as x
        from public.sections s left join t_all t on t.section_code = s.code
        where p_section is null or s.code = p_section
        group by s.code, s.name
      ) q), '[]'::jsonb),
    'by_payment', coalesce((
      select jsonb_agg(jsonb_build_object('section_code', section_code, 'payment_method', payment_method,
        'revenue', revenue, 'transactions', n) order by section_code, payment_method)
      from (select section_code, payment_method, sum(total) as revenue, count(*) as n
            from t_ok group by 1, 2) q), '[]'::jsonb),
    'by_day', coalesce((
      select jsonb_agg(jsonb_build_object('business_date', business_date, 'section_code', section_code,
        'revenue', revenue, 'transactions', n, 'units', units, 'cogs', cogs, 'gross_profit', revenue - cogs,
        'cash', cash, 'telda', telda, 'instapay', instapay) order by business_date, section_code)
      from (select business_date, section_code, sum(total) as revenue, count(*) as n, sum(item_count) as units,
                   sum(total_cost) as cogs,
                   coalesce(sum(total) filter (where payment_method = 'CASH'), 0) as cash,
                   coalesce(sum(total) filter (where payment_method = 'TELDA'), 0) as telda,
                   coalesce(sum(total) filter (where payment_method = 'INSTAPAY'), 0) as instapay
            from t_ok group by 1, 2) q), '[]'::jsonb),
    'by_hour', coalesce((
      select jsonb_agg(jsonb_build_object('hour', h, 'revenue', revenue, 'transactions', n) order by h)
      from (select extract(hour from created_at at time zone public.app_timezone())::int as h,
                   sum(total) as revenue, count(*) as n from t_ok group by 1) q), '[]'::jsonb),
    'by_product', coalesce((
      select jsonb_agg(jsonb_build_object('product_id', product_id, 'product_name', product_name,
        'section_code', section_code, 'category_name', category_name, 'units', units, 'revenue', revenue,
        'cogs', cogs, 'gross_profit', revenue - cogs) order by revenue desc, product_name)
      from (select li.product_id, coalesce(p.name, max(li.product_name)) as product_name, li.section_code,
                   max(li.category_name) as category_name, sum(li.quantity) as units,
                   sum(li.line_total) as revenue, sum(li.line_cost) as cogs
            from li left join public.products p on p.id = li.product_id
            group by li.product_id, p.name, li.section_code) q), '[]'::jsonb),
    'by_category', coalesce((
      select jsonb_agg(jsonb_build_object('section_code', section_code, 'category_name', category_name,
        'units', units, 'revenue', revenue, 'cogs', cogs, 'gross_profit', revenue - cogs) order by revenue desc)
      from (select section_code, coalesce(category_name, 'Uncategorised') as category_name, sum(quantity) as units,
                   sum(line_total) as revenue, sum(line_cost) as cogs
            from li group by 1, 2) q), '[]'::jsonb),
    'by_cashier', coalesce((
      select jsonb_agg(jsonb_build_object('cashier_id', cashier_id, 'cashier_name', cashier_name,
        'section_code', section_code, 'transactions', n, 'revenue', revenue, 'cash', cash, 'telda', telda,
        'instapay', instapay, 'voided_count', voided_count, 'voided_amount', voided_amount) order by revenue desc)
      from (select t.cashier_id, coalesce(nullif(pr.full_name, ''), pr.username) as cashier_name, t.section_code,
                   count(*) filter (where t.status = 'completed') as n,
                   coalesce(sum(t.total) filter (where t.status = 'completed'), 0) as revenue,
                   coalesce(sum(t.total) filter (where t.status = 'completed' and t.payment_method = 'CASH'), 0) as cash,
                   coalesce(sum(t.total) filter (where t.status = 'completed' and t.payment_method = 'TELDA'), 0) as telda,
                   coalesce(sum(t.total) filter (where t.status = 'completed' and t.payment_method = 'INSTAPAY'), 0) as instapay,
                   count(*) filter (where t.status = 'voided') as voided_count,
                   coalesce(sum(t.total) filter (where t.status = 'voided'), 0) as voided_amount
            from t_all t join public.profiles pr on pr.id = t.cashier_id
            group by t.cashier_id, pr.full_name, pr.username, t.section_code) q), '[]'::jsonb)
  ) into v;
  return v;
end $$;

create or replace function public.admin_cash_summary(p_date date, p_section text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require_roles(array['admin', 'finance']);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'section_code', k.section_code, 'section_name', s.name, 'cashier_id', k.cashier_id,
      'cashier_name', coalesce(nullif(p.full_name, ''), p.username),
      'transaction_count', coalesce(f.transaction_count, 0),
      'cash_sales', coalesce(f.cash_sales, 0), 'cash_refunds', coalesce(f.cash_refunds, 0),
      'expected_cash', coalesce(f.cash_sales, 0) - coalesce(f.cash_refunds, 0),
      'telda_sales', coalesce(f.telda_sales, 0), 'instapay_sales', coalesce(f.instapay_sales, 0),
      'handover', (select to_jsonb(h) from public.cash_handovers h
                   where h.business_date = p_date and h.section_code = k.section_code
                     and h.cashier_id = k.cashier_id and h.superseded_at is null)
    ) order by s.sort_order, coalesce(nullif(p.full_name, ''), p.username))
    from (
      select f2.section_code, f2.cashier_id from public._cash_figures(p_date) f2
      union
      select h.section_code, h.cashier_id from public.cash_handovers h
      where h.business_date = p_date and h.superseded_at is null
    ) k
    join public.sections s on s.code = k.section_code
    join public.profiles p on p.id = k.cashier_id
    left join public._cash_figures(p_date) f on f.section_code = k.section_code and f.cashier_id = k.cashier_id
    where p_section is null or k.section_code = p_section
  ), '[]'::jsonb);
end $$;

create or replace function public.admin_record_handover(
  p_date date, p_section text, p_cashier_id uuid, p_actual_cash numeric, p_notes text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me public.profiles; f record; v_prev public.cash_handovers; v_new public.cash_handovers;
  v_actual numeric(12,2) := round(p_actual_cash, 2);
begin
  v_me := public._require_roles(array['admin', 'finance']);
  if v_actual is null or v_actual < 0 then
    perform public._fail('BAD_REQUEST', 'Enter the counted cash (0 or more).');
  end if;
  -- serialise concurrent recordings for the same box
  perform pg_advisory_xact_lock(hashtextextended('handover:' || p_date || p_section || p_cashier_id::text, 0));

  select * into f from public._cash_figures(p_date) x where x.section_code = p_section and x.cashier_id = p_cashier_id;
  if not found then
    f := row(p_section, p_cashier_id, 0, 0::numeric, 0::numeric, 0::numeric, 0::numeric);
  end if;
  if not exists (select 1 from public.profiles where id = p_cashier_id) then
    perform public._fail('NOT_FOUND', 'Cashier not found.');
  end if;

  select * into v_prev from public.cash_handovers
  where business_date = p_date and section_code = p_section and cashier_id = p_cashier_id and superseded_at is null
  for update;

  if v_prev.id is not null then
    update public.cash_handovers set superseded_at = now() where id = v_prev.id;
  end if;

  insert into public.cash_handovers (business_date, section_code, cashier_id, cash_sales, cash_refunds, telda_sales,
    instapay_sales, transaction_count, expected_cash, actual_cash, difference, notes, recorded_by)
  values (p_date, p_section, p_cashier_id, f.cash_sales, f.cash_refunds, f.telda_sales, f.instapay_sales,
    f.transaction_count, f.cash_sales - f.cash_refunds, v_actual, v_actual - (f.cash_sales - f.cash_refunds),
    nullif(trim(coalesce(p_notes, '')), ''), v_me.id)
  returning * into v_new;

  -- the link between the old and the new count is recorded in the audit log ('replaces')
  perform public._audit(case when v_prev.id is null then 'cash_handover_recorded' else 'cash_handover_corrected' end,
    p_section, 'cash_handover', v_new.id::text,
    jsonb_build_object('business_date', p_date, 'cashier_id', p_cashier_id, 'expected_cash', v_new.expected_cash,
      'actual_cash', v_new.actual_cash, 'difference', v_new.difference, 'replaces', v_prev.id,
      'previous_actual_cash', v_prev.actual_cash));
  return to_jsonb(v_new);
end $$;

create or replace function public.pos_checkout(
  p_idempotency_key uuid,
  p_items jsonb,
  p_payment_method public.payment_method,
  p_amount_received numeric default null,
  p_expected_total numeric default null,
  p_section text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me        public.profiles;
  v_section   public.sections;
  v_existing  public.transactions;
  v_el        jsonb;
  v_q         numeric;
  v_ids       bigint[];
  v_qtys      int[];
  r           record;
  v_total     numeric(12,2) := 0;
  v_cost      numeric(12,2) := 0;
  v_units     int := 0;
  v_received  numeric(12,2);
  v_change    numeric(12,2);
  v_txn_id    uuid;
  v_txn_no    text;
  v_after     int;
begin
  v_me := public._require_roles(array['admin', 'cashier']);

  -- which section is this sale for? A cashier can ONLY sell in their own.
  if v_me.role = 'cashier' then
    if p_section is not null and p_section <> v_me.section_code then
      perform public._fail('FORBIDDEN', 'You can only sell in your own section.', '42501');
    end if;
    select * into v_section from public.sections where code = v_me.section_code;
  else
    select * into v_section from public.sections where code = p_section;
    if not found then
      perform public._fail('SECTION_REQUIRED', 'Choose a section (Bazaar or Snacks) for this sale.');
    end if;
  end if;

  if p_idempotency_key is null then
    perform public._fail('BAD_REQUEST', 'Missing checkout key.');
  end if;

  -- IDEMPOTENCY: serialise all attempts that share a key. A retry waits here
  -- until the first attempt commits, then finds it below and returns it.
  perform pg_advisory_xact_lock(hashtextextended('pos_checkout:' || p_idempotency_key::text, 0));
  select * into v_existing from public.transactions where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.cashier_id <> v_me.id then
      perform public._fail('BAD_REQUEST', 'This checkout key belongs to another user.', '42501');
    end if;
    return public._receipt_json(v_existing.id) || jsonb_build_object('duplicate', true);
  end if;

  -- validate the cart payload
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    perform public._fail('EMPTY_CART', 'The cart is empty.');
  end if;
  if jsonb_array_length(p_items) > 200 then
    perform public._fail('BAD_REQUEST', 'Too many lines in one sale.');
  end if;
  for v_el in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_el -> 'product_id') is distinct from 'number'
       or jsonb_typeof(v_el -> 'quantity') is distinct from 'number' then
      perform public._fail('BAD_REQUEST', 'Invalid cart line.');
    end if;
    v_q := (v_el ->> 'quantity')::numeric;
    if v_q <> trunc(v_q) or v_q < 1 or v_q > 10000 then
      perform public._fail('BAD_QUANTITY', 'Quantities must be whole numbers of at least 1.');
    end if;
  end loop;

  select array_agg(pid order by pid), array_agg(qty order by pid)
    into v_ids, v_qtys
  from (
    select (e ->> 'product_id')::bigint as pid, sum((e ->> 'quantity')::int)::int as qty
    from jsonb_array_elements(p_items) e group by 1
  ) s;

  -- CONCURRENCY: lock the product rows (in id order, so two checkouts can't
  -- deadlock). A second cashier buying the same last item waits here, then
  -- sees the reduced stock and is refused.
  perform 1 from public.products where id = any (v_ids) order by id for update;

  for r in
    select a.pid, a.qty, p.id, p.name, p.section_code, p.active, p.price, p.stock, p.track_stock,
           coalesce(c.cost, 0) as cost
    from unnest(v_ids, v_qtys) as a(pid, qty)
    left join public.products p on p.id = a.pid
    left join public.product_costs c on c.product_id = p.id
    order by a.pid
  loop
    if r.id is null then
      perform public._fail('PRODUCT_NOT_FOUND', format('Product #%s no longer exists.', r.pid));
    end if;
    if r.section_code <> v_section.code then
      perform public._fail('WRONG_SECTION', format('%s is not sold in %s.', r.name, v_section.name), '42501');
    end if;
    if not r.active then
      perform public._fail('PRODUCT_INACTIVE', format('%s is no longer available.', r.name));
    end if;
    if r.track_stock and r.stock < r.qty then
      perform public._fail('INSUFFICIENT_STOCK',
        case when r.stock = 0 then format('%s is out of stock.', r.name)
             else format('Only %s × %s left in stock.', r.stock, r.name) end);
    end if;
    v_total := v_total + r.price * r.qty;
    v_cost := v_cost + r.cost * r.qty;
    v_units := v_units + r.qty;
  end loop;

  if p_expected_total is not null and p_expected_total <> v_total then
    perform public._fail('PRICE_CHANGED',
      format('Prices changed since the cart was filled. New total is %s. Please review the cart.', v_total));
  end if;

  if p_payment_method = 'CASH' then
    if p_amount_received is null then
      perform public._fail('CASH_REQUIRED', 'Enter the amount received from the customer.');
    end if;
    v_received := round(p_amount_received, 2);
    if v_received < v_total then
      perform public._fail('CASH_TOO_LOW', 'Amount received is less than the total.');
    end if;
    v_change := v_received - v_total;
  end if;

  v_txn_id := gen_random_uuid();
  v_txn_no := v_section.txn_prefix || '-' || lpad(nextval('public.transaction_no_seq')::text, 6, '0');

  insert into public.transactions (id, txn_no, idempotency_key, section_code, cashier_id, business_date,
    item_count, total, total_cost, payment_method, amount_received, change_given)
  values (v_txn_id, v_txn_no, p_idempotency_key, v_section.code, v_me.id, public.business_date_of(now()),
    v_units, v_total, v_cost, p_payment_method, v_received, v_change);

  for r in
    select a.pid, a.qty, p.name, p.price, p.track_stock, coalesce(c.cost, 0) as cost, cat.name as category_name
    from unnest(v_ids, v_qtys) as a(pid, qty)
    join public.products p on p.id = a.pid
    left join public.product_costs c on c.product_id = p.id
    left join public.categories cat on cat.id = p.category_id
    order by a.pid
  loop
    -- price AND cost are snapshotted onto the line: later product edits never
    -- change historical revenue, COGS or profit
    insert into public.transaction_items (transaction_id, section_code, product_id, product_name, category_name,
      quantity, unit_price, unit_cost, line_total, line_cost)
    values (v_txn_id, v_section.code, r.pid, r.name, r.category_name,
      r.qty, r.price, r.cost, r.price * r.qty, r.cost * r.qty);

    if r.track_stock then
      update public.products set stock = stock - r.qty where id = r.pid returning stock into v_after;
      insert into public.stock_movements (product_id, section_code, movement_type, quantity_change,
        stock_before, stock_after, transaction_id, created_by, reason)
      values (r.pid, v_section.code, 'sale', -r.qty, v_after + r.qty, v_after, v_txn_id, v_me.id, v_txn_no);
    end if;
  end loop;

  perform public._audit('sale_completed', v_section.code, 'transaction', v_txn_id::text,
    jsonb_build_object('txn_no', v_txn_no, 'total', v_total, 'payment_method', p_payment_method,
      'amount_received', v_received, 'change', v_change, 'units', v_units));

  return public._receipt_json(v_txn_id) || jsonb_build_object('duplicate', false);
end $$;

create or replace function public.pos_checkout_status(p_idempotency_key uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_me public.profiles; v_id uuid;
begin
  v_me := public._require_roles(array['admin', 'cashier']);
  select id into v_id from public.transactions
  where idempotency_key = p_idempotency_key and cashier_id = v_me.id;
  if v_id is null then return null; end if;
  return public._receipt_json(v_id);
end $$;

create or replace function public.pos_my_transactions(p_limit int default 200)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_me public.profiles;
begin
  v_me := public._require_roles(array['admin', 'cashier']);
  return coalesce((
    select jsonb_agg(public._receipt_json(t.id) order by t.created_at desc)
    from (
      select id, created_at from public.transactions
      where cashier_id = v_me.id and business_date = public.business_date_of(now())
      order by created_at desc
      limit least(greatest(coalesce(p_limit, 200), 1), 500)
    ) t), '[]'::jsonb);
end $$;

create or replace function public.pos_request_void(p_transaction_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me  public.profiles;
  v_txn public.transactions;
  v_id  bigint;
begin
  v_me := public._require_roles(array['admin', 'cashier']);
  if length(trim(coalesce(p_reason, ''))) < 3 then
    perform public._fail('REASON_REQUIRED', 'Please write the reason for the void (at least 3 characters).');
  end if;

  select * into v_txn from public.transactions where id = p_transaction_id for update;
  if not found then
    perform public._fail('NOT_FOUND', 'Transaction not found.');
  end if;
  -- a cashier may only request voids for their OWN sales
  if v_me.role = 'cashier' and v_txn.cashier_id <> v_me.id then
    perform public._fail('FORBIDDEN', 'You can only request a void for your own sales.', '42501');
  end if;
  if v_txn.status <> 'completed' then
    perform public._fail('ALREADY_VOIDED', 'This transaction is already voided.');
  end if;
  if exists (select 1 from public.void_requests where transaction_id = v_txn.id and status = 'pending') then
    perform public._fail('ALREADY_REQUESTED', 'A void request for this sale is already waiting for approval.');
  end if;

  insert into public.void_requests (transaction_id, section_code, requested_by, reason)
  values (v_txn.id, v_txn.section_code, v_me.id, trim(p_reason))
  returning id into v_id;

  perform public._audit('void_requested', v_txn.section_code, 'transaction', v_txn.id::text,
    jsonb_build_object('txn_no', v_txn.txn_no, 'void_request_id', v_id, 'reason', trim(p_reason), 'total', v_txn.total));
  return jsonb_build_object('void_request_id', v_id, 'status', 'pending');
end $$;

create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_meta     jsonb := coalesce(new.raw_app_meta_data, '{}'::jsonb);
  v_role     public.app_role;
  v_section  text;
  v_active   boolean := false;
  v_base     text;
  v_username text;
  v_n        int := 0;
begin
  if v_meta ->> 'pos_role' in ('admin', 'cashier', 'finance', 'product_manager', 'supplier') then
    v_role := (v_meta ->> 'pos_role')::public.app_role;
    v_section := case when v_role = 'cashier' then nullif(v_meta ->> 'pos_section', '') end;
    if v_role <> 'cashier' or exists (select 1 from public.sections s where s.code = v_section) then
      v_active := true;
    else
      v_section := null;
    end if;
  else
    v_role := 'cashier';
  end if;

  v_base := lower(coalesce(nullif(v_meta ->> 'pos_username', ''), split_part(coalesce(new.email, ''), '@', 1)));
  v_base := regexp_replace(v_base, '[^a-z0-9._-]', '-', 'g');
  if length(v_base) < 2 then v_base := 'user-' || left(new.id::text, 8); end if;
  v_base := left(v_base, 34);
  v_username := v_base;
  while exists (select 1 from public.profiles p where p.username = v_username) loop
    v_n := v_n + 1;
    v_username := v_base || '-' || v_n;
  end loop;

  insert into public.profiles (id, username, login_email, full_name, role, section_code, active)
  values (new.id, v_username, coalesce(new.email, ''),
          left(coalesce(nullif(v_meta ->> 'pos_full_name', ''), v_username), 80),
          v_role, v_section, v_active);
  return new;
end $$;

create or replace function public.handle_auth_user_meta_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_new     jsonb := coalesce(new.raw_app_meta_data, '{}'::jsonb);
  v_old     jsonb := coalesce(old.raw_app_meta_data, '{}'::jsonb);
  v_role    public.app_role;
  v_section text;
  v_user    text;
begin
  if v_new ->> 'pos_role' not in ('admin', 'cashier', 'finance', 'product_manager', 'supplier') then return new; end if;
  if (v_new ->> 'pos_role', v_new ->> 'pos_section', v_new ->> 'pos_username', v_new ->> 'pos_full_name')
     is not distinct from
     (v_old ->> 'pos_role', v_old ->> 'pos_section', v_old ->> 'pos_username', v_old ->> 'pos_full_name') then
    return new;
  end if;
  v_role := (v_new ->> 'pos_role')::public.app_role;
  v_section := case when v_role = 'cashier' then nullif(v_new ->> 'pos_section', '') end;
  if v_role = 'cashier' and not exists (select 1 from public.sections s where s.code = v_section) then
    return new;
  end if;
  v_user := lower(nullif(v_new ->> 'pos_username', ''));
  update public.profiles p
     set role = v_role,
         section_code = v_section,
         active = true,
         full_name = left(coalesce(nullif(v_new ->> 'pos_full_name', ''), p.full_name), 80),
         username = case
           when v_user ~ '^[a-z0-9._-]{2,40}$'
                and not exists (select 1 from public.profiles x where x.username = v_user and x.id <> p.id)
           then v_user else p.username end
   where p.id = new.id;
  return new;
end $$;

-- Product managers can upload product images but cannot manage accounts/settings.
create policy "product images: manager upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and (select public.has_role(array['product_manager'])));
create policy "product images: manager update" on storage.objects for update to authenticated
  using (bucket_id = 'product-images' and (select public.has_role(array['product_manager'])))
  with check (bucket_id = 'product-images' and (select public.has_role(array['product_manager'])));
create policy "product images: manager delete" on storage.objects for delete to authenticated
  using (bucket_id = 'product-images' and (select public.has_role(array['product_manager'])));
$migration$; end if; end $upgrade$;

do $upgrade$ begin if to_regclass('public.supplier_orders') is null then execute $migration$
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
$migration$; end if; end $upgrade$;

do $upgrade$ begin if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='supplier_order_items' and column_name='delivered_at') then execute $migration$
-- Run once after the supplier-orders migration. Existing stock and receipts
-- are preserved; historical receipts are not treated as supplier confirmations.

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
$migration$; end if; end $upgrade$;

do $upgrade$ begin if to_regclass('public.money_start') is null then execute $migration$
-- Money tracking begins only when Admin records current opening balances.
-- Existing stock and transactions are preserved, never backcharged.
create table public.money_start (
 id int primary key check(id = 1), started_at timestamptz not null default clock_timestamp(),
 created_by uuid not null references public.profiles(id), request_key uuid not null unique,
 balances jsonb not null
);
create table public.money_actions (
 id uuid primary key, created_by uuid not null references public.profiles(id),
 payload jsonb not null, result jsonb, created_at timestamptz not null default clock_timestamp()
);
create table public.money_ledger (
 id bigint generated always as identity primary key,
 action_id uuid references public.money_actions(id),
 transaction_id uuid references public.transactions(id),
 account public.payment_method not null,
 amount numeric(16,2) not null, cogs numeric(16,2) not null default 0,
 kind text not null check(kind in ('opening','purchase','sale','refund','legacy_refund','expense','transfer','stock_loss')),
 note text not null, created_by uuid references public.profiles(id),
 created_at timestamptz not null default clock_timestamp()
);
create unique index money_sale_once on public.money_ledger(transaction_id,kind) where transaction_id is not null;
create index money_ledger_action on public.money_ledger(action_id);
create index money_ledger_account on public.money_ledger(account);
create trigger money_ledger_immutable before update or delete on public.money_ledger
 for each row execute function public.forbid_change();
create trigger money_start_immutable before update or delete on public.money_start
 for each row execute function public.forbid_change();
alter table public.money_start enable row level security;
alter table public.money_actions enable row level security;
alter table public.money_ledger enable row level security;
revoke all on public.money_start,public.money_actions,public.money_ledger from anon,authenticated;
grant select on public.money_start,public.money_ledger to authenticated;
create policy money_start_read on public.money_start for select to authenticated using (public.has_role(array['admin','finance','product_manager']));
create policy money_ledger_read on public.money_ledger for select to authenticated using (public.has_role(array['admin','finance']));

create function public._money_lock() returns void language sql security definer set search_path='' as $$
 select pg_advisory_xact_lock(719204051);
$$;
create function public._money_ready() returns void language plpgsql security definer set search_path='' as $$
begin
 perform public._money_lock();
 if not exists(select 1 from public.money_start) then
  perform public._fail('MONEY_SETUP_REQUIRED','Ask Admin to enter starting money on the Money page first.');
 end if;
end $$;
create function public._money_amount(p numeric, allow_zero boolean default false) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p is null or p::text in ('NaN','Infinity','-Infinity') or p < 0 or (not allow_zero and p = 0) or p > 9999999999.99 or p <> round(p,2) then
  perform public._fail('BAD_AMOUNT','Enter a valid amount with at most two decimal places.');
 end if;
end $$;
create function public._money_funds(p_account public.payment_method,p_amount numeric) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform public._money_ready();
 if p_account is null then perform public._fail('BAD_ACCOUNT','Choose the payment account.'); end if;
 if (select coalesce(sum(amount),0) from public.money_ledger where account=p_account) < p_amount then
  perform public._fail('INSUFFICIENT_FUNDS','Not enough money in the selected account. Check its balance or record a transfer first.');
 end if;
end $$;
create function public._money_claim(p_key uuid,p_payload jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare v public.money_actions;
begin
 if p_key is null then perform public._fail('BAD_REQUEST','A retry key is required.'); end if;
 perform pg_advisory_xact_lock(hashtextextended('money:'||p_key::text,0));
 select * into v from public.money_actions where id=p_key;
 if found then
  if v.created_by <> auth.uid() or v.payload <> p_payload then
   perform public._fail('KEY_REUSED','This retry key belongs to a different action.');
  end if;
  return false;
 end if;
 insert into public.money_actions(id,created_by,payload) values(p_key,auth.uid(),p_payload);
 return true;
end $$;

create function public.money_open(p_key uuid,p_cash numeric,p_telda numeric,p_instapay numeric) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform public._require_admin();
 perform public._money_amount(p_cash,true); perform public._money_amount(p_telda,true); perform public._money_amount(p_instapay,true);
 if not public._money_claim(p_key,jsonb_build_object('kind','opening','cash',p_cash,'telda',p_telda,'instapay',p_instapay)) then return; end if;
 perform public._money_lock();
 if exists(select 1 from public.money_start) then perform public._fail('ALREADY_STARTED','Starting money has already been recorded.'); end if;
 insert into public.money_start(id,created_by,request_key,balances) values(1,auth.uid(),p_key,jsonb_build_object('CASH',p_cash,'TELDA',p_telda,'INSTAPAY',p_instapay));
 insert into public.money_ledger(action_id,account,amount,kind,note,created_by) values
 (p_key,'CASH',p_cash,'opening','Starting cash',auth.uid()),(p_key,'TELDA',p_telda,'opening','Starting Telda',auth.uid()),(p_key,'INSTAPAY',p_instapay,'opening','Starting InstaPay',auth.uid());
 perform public._audit('money_started',null,'money',p_key::text,jsonb_build_object('cash',p_cash,'telda',p_telda,'instapay',p_instapay));
end $$;

-- Sales use the net amount kept (total, after change), never tendered cash.
-- Trigger serialization makes opening/checkout races deterministic.
create function public._money_sale() returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform public._money_lock();
 if not exists(select 1 from public.money_start) then return new; end if;
 if TG_OP='INSERT' then
  insert into public.money_ledger(transaction_id,account,amount,cogs,kind,note,created_by)
   values(new.id,new.payment_method,new.total,new.total_cost,'sale','Sale '||new.txn_no,new.cashier_id);
 elsif old.status='completed' and new.status='voided' then
  -- A void means the full payment is returned via the original account.
  insert into public.money_ledger(transaction_id,account,amount,cogs,kind,note,created_by)
   values(new.id,new.payment_method,-new.total,
    case when exists(select 1 from public.money_ledger where transaction_id=new.id and kind='sale') then -new.total_cost else 0 end,
    case when exists(select 1 from public.money_ledger where transaction_id=new.id and kind='sale') then 'refund' else 'legacy_refund' end,
    'Refund '||new.txn_no,new.voided_by);
 end if;
 return new;
end $$;
create trigger money_sale after insert or update of status on public.transactions for each row execute function public._money_sale();

create function public.money_record(p_key uuid,p_kind text,p_account public.payment_method,p_amount numeric,p_note text,p_to public.payment_method default null)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform public._require_roles(array['admin','finance']);
 perform public._money_amount(p_amount);
 if length(trim(coalesce(p_note,''))) < 3 or length(p_note)>500 then perform public._fail('REASON_REQUIRED','Enter a description (3–500 characters).'); end if;
 if p_kind is null or p_kind not in ('expense','transfer') then perform public._fail('BAD_REQUEST','Choose expense or transfer.'); end if;
 if p_kind='transfer' and (p_to is null or p_to=p_account) then perform public._fail('BAD_ACCOUNT','Choose a different destination account.'); end if;
 if p_kind='expense' and p_to is not null then perform public._fail('BAD_ACCOUNT','Expenses have no destination account.'); end if;
 if not public._money_claim(p_key,jsonb_build_object('kind',p_kind,'account',p_account,'amount',p_amount,'note',p_note,'to',p_to)) then return; end if;
 perform public._money_funds(p_account,p_amount);
 insert into public.money_ledger(action_id,account,amount,kind,note,created_by) values(p_key,p_account,-p_amount,p_kind,trim(p_note),auth.uid());
 if p_kind='transfer' then
  insert into public.money_ledger(action_id,account,amount,kind,note,created_by) values(p_key,p_to,p_amount,p_kind,trim(p_note),auth.uid());
 end if;
 perform public._audit('money_'||p_kind,null,'money',p_key::text,jsonb_build_object('amount',p_amount,'account',p_account,'to',p_to,'note',p_note));
end $$;

create function public.money_summary() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v jsonb;
begin
 perform public._require_roles(array['admin','finance']);
 select jsonb_build_object('started_at',(select started_at from public.money_start),
 'cash',coalesce(sum(amount) filter(where account='CASH'),0),
 'telda',coalesce(sum(amount) filter(where account='TELDA'),0),
 'instapay',coalesce(sum(amount) filter(where account='INSTAPAY'),0),
 'total',coalesce(sum(amount),0),
 'starting',coalesce(sum(amount) filter(where kind='opening'),0),
 'sales',coalesce(sum(amount) filter(where kind in ('sale','refund')),0),
 'cogs',coalesce(sum(cogs) filter(where kind in ('sale','refund')),0),
 'purchases',-coalesce(sum(amount) filter(where kind='purchase'),0),
 'expenses',-coalesce(sum(amount) filter(where kind='expense'),0),
 'stock_losses',coalesce(sum(cogs) filter(where kind='stock_loss'),0),
 'legacy_refunds',-coalesce(sum(amount) filter(where kind='legacy_refund'),0),
 'gross_profit',coalesce(sum(amount-cogs) filter(where kind in ('sale','refund')),0),
 'net_profit',coalesce(sum(amount-cogs) filter(where kind in ('sale','refund')),0)
  +coalesce(sum(amount) filter(where kind='expense'),0)-coalesce(sum(cogs) filter(where kind='stock_loss'),0)
 ) into v from public.money_ledger;
 return v;
end $$;

create or replace function public._stock_adjust_original(p_product_id bigint, p_mode text, p_quantity int, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me    public.profiles;
  v     public.products;
  v_delta int;
  v_after int;
begin
  v_me := public._require_roles(array['admin', 'product_manager']);
  if length(trim(coalesce(p_reason, ''))) < 3 then
    perform public._fail('REASON_REQUIRED', 'A reason is required for every stock adjustment (at least 3 characters).');
  end if;
  if p_quantity is null or p_quantity < 0 then
    perform public._fail('BAD_QUANTITY', 'Quantity must be 0 or more.');
  end if;
  select * into v from public.products where id = p_product_id for update;
  if not found then perform public._fail('NOT_FOUND', 'Product not found.'); end if;
  if not v.track_stock then
    perform public._fail('BAD_REQUEST', 'This product does not track stock (service).');
  end if;

  v_delta := case p_mode
    when 'add' then p_quantity
    when 'remove' then -p_quantity
    when 'set' then p_quantity - v.stock
  end;
  if v_delta is null then perform public._fail('BAD_REQUEST', 'Mode must be add, remove or set.'); end if;
  if v_delta = 0 then perform public._fail('NO_CHANGE', 'Nothing to change: the stock is already at that level.'); end if;
  if v.stock + v_delta < 0 then
    perform public._fail('INSUFFICIENT_STOCK', format('Cannot remove %s: only %s in stock.', -v_delta, v.stock));
  end if;

  update public.products set stock = stock + v_delta where id = v.id returning stock into v_after;
  insert into public.stock_movements (product_id, section_code, movement_type, quantity_change, stock_before,
    stock_after, created_by, reason)
  values (v.id, v.section_code, case when v_delta > 0 then 'adjust_add' else 'adjust_remove' end::public.stock_movement_type,
    v_delta, v.stock, v_after, v_me.id, trim(p_reason));
  perform public._audit('stock_adjusted', v.section_code, 'product', v.id::text,
    jsonb_build_object('name', v.name, 'mode', p_mode, 'change', v_delta, 'from', v.stock, 'to', v_after, 'reason', trim(p_reason)));
  return jsonb_build_object('product_id', v.id, 'stock', v_after, 'change', v_delta);
end $$;

create or replace function public._receive_supplier_original(p_key uuid, p_item bigint, p_quantity int)
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
  perform public._stock_adjust_original(v_item.product_id, 'add', p_quantity,
    'Supplier receipt ' || p_key::text || ' for list ' || v_item.order_id::text);
  insert into public.supplier_receipts(id, item_id, quantity, recorded_by)
    values(p_key, p_item, p_quantity, v_me.id);
  update public.supplier_order_items set received = received + p_quantity where id = p_item;
  perform public._audit('supplier_goods_received', null, 'supplier_order', v_item.order_id::text,
    jsonb_build_object('receipt_id', p_key, 'item_id', p_item, 'quantity', p_quantity));
end $$;

-- Old clients cannot bypass money tracking once opening balances are recorded.
create or replace function public.admin_adjust_stock(p_product_id bigint,p_mode text,p_quantity int,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public._require_roles(array['admin','product_manager']);
 perform 1 from public.products where id=p_product_id for update;
 perform public._money_lock();
 if exists(select 1 from public.money_start) then perform public._fail('UPGRADE_REQUIRED','Refresh the website and use the stock form with payment details.'); end if;
 return public._stock_adjust_original(p_product_id,p_mode,p_quantity,p_reason);
end $$;
create or replace function public.receive_supplier_item(p_key uuid,p_item bigint,p_quantity int)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform public._require_roles(array['admin','product_manager']);
 perform 1 from public.supplier_order_items where id=p_item for update;
 perform 1 from public.products where id=(select product_id from public.supplier_order_items where id=p_item) for update;
 perform public._money_lock();
 if exists(select 1 from public.money_start) then perform public._fail('UPGRADE_REQUIRED','Refresh the website and enter the receipt payment details.'); end if;
 perform public._receive_supplier_original(p_key,p_item,p_quantity);
end $$;

-- One atomic action updates stock, average cost, receipt history and money.
create function public.money_stock(p_key uuid,p_product bigint,p_mode text,p_quantity int,p_reason text,
 p_unit_cost numeric,p_account public.payment_method,p_no_spend boolean,p_item bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.products; v_cost numeric; v_delta int; v_total numeric; v_result jsonb; v_item public.supplier_order_items;
begin
 perform public._require_roles(array['admin','product_manager']);
 if length(trim(coalesce(p_reason,'')))<3 or length(p_reason)>500 then perform public._fail('REASON_REQUIRED','Enter a reason (3–500 characters).'); end if;
 if p_no_spend is null then perform public._fail('BAD_REQUEST','Choose purchased stock or no money spent.'); end if;
 if not public._money_claim(p_key,jsonb_build_object('kind','stock','product',p_product,'mode',p_mode,'quantity',p_quantity,
  'reason',p_reason,'unit_cost',p_unit_cost,'account',p_account,'no_spend',p_no_spend,'item',p_item)) then
  return (select result from public.money_actions where id=p_key);
 end if;
 if p_item is not null then
  select * into v_item from public.supplier_order_items where id=p_item for update;
  if not found or v_item.product_id is distinct from p_product or p_mode is distinct from 'add' or p_no_spend then
   perform public._fail('BAD_REQUEST','Supplier receipts must record a paid stock purchase.');
  end if;
  -- Never charge a receipt that was recorded by the old workflow.
  if exists(select 1 from public.supplier_receipts where id=p_key) then perform public._fail('KEY_REUSED','This receipt was already recorded before money tracking.'); end if;
 end if;
 select * into v from public.products where id=p_product for update;
 if not found then perform public._fail('NOT_FOUND','Product not found.'); end if;
 select cost into v_cost from public.product_costs where product_id=p_product;
 v_cost:=coalesce(v_cost,0);
 perform public._money_ready();
 if p_quantity is null or p_quantity<0 or (p_mode <> 'set' and p_quantity=0) then perform public._fail('BAD_QUANTITY','Enter a valid whole quantity.'); end if;
 v_delta:=case p_mode when 'add' then p_quantity when 'remove' then -p_quantity when 'set' then p_quantity-v.stock end;
 if not p_no_spend then
  if p_mode is distinct from 'add' then perform public._fail('BAD_REQUEST','Use Add stock to record a purchase.'); end if;
  perform public._money_amount(p_unit_cost,true);
  v_total:=p_quantity*p_unit_cost;
  perform public._money_funds(p_account,v_total);
 else
  if p_account is not null or p_unit_cost is not null then perform public._fail('BAD_REQUEST','No-money adjustments must not include a payment.'); end if;
 end if;
 if p_item is null then
  v_result:=public._stock_adjust_original(p_product,p_mode,p_quantity,p_reason);
 else
  perform public._receive_supplier_original(p_key,p_item,p_quantity);
  v_result:=jsonb_build_object('product_id',p_product,'stock',v.stock+p_quantity,'change',p_quantity);
 end if;
 if not p_no_spend then
  insert into public.money_ledger(action_id,account,amount,kind,note,created_by)
   values(p_key,p_account,-v_total,'purchase',v.name||' × '||p_quantity||' @ '||p_unit_cost||' — '||p_reason,auth.uid());
  update public.product_costs set cost=round((v.stock*v_cost+v_total)/(v.stock+p_quantity),2) where product_id=p_product;
 elsif v_delta < 0 then
  -- A stock loss affects profit, but no money leaves an account.
  insert into public.money_ledger(action_id,account,amount,cogs,kind,note,created_by)
   values(p_key,'CASH',0,-v_delta*v_cost,'stock_loss',v.name||' — '||p_reason,auth.uid());
 elsif p_mode='add' then
  -- Free/donated additions carry zero purchase cost.
  update public.product_costs set cost=round(v.stock*v_cost/(v.stock+v_delta),2) where product_id=p_product;
 end if;
 update public.money_actions set result=v_result where id=p_key;
 perform public._audit('money_stock_received',v.section_code,'money',p_key::text,jsonb_build_object('product_id',p_product,'change',v_delta,'amount',coalesce(v_total,0),'account',p_account,'item_id',p_item,'no_spend',p_no_spend));
 return v_result;
end $$;

create or replace function public._save_product_original(p jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_me       public.profiles;
  v_old      public.products;
  v_old_cost numeric(12,2);
  v_id       bigint := nullif(p ->> 'id', '')::bigint;
  v_section  text := p ->> 'section_code';
  v_cat      bigint := nullif(p ->> 'category_id', '')::bigint;
  v_name     text := trim(coalesce(p ->> 'name', ''));
  v_sku      text := nullif(trim(coalesce(p ->> 'sku', '')), '');
  v_price    numeric(12,2) := (p ->> 'price')::numeric;
  v_cost     numeric(12,2) := coalesce(nullif(p ->> 'cost', '')::numeric, 0);
  v_image    text := nullif(trim(coalesce(p ->> 'image_url', '')), '');
  v_track    boolean := coalesce((p ->> 'track_stock')::boolean, true);
  v_start    int := coalesce(nullif(p ->> 'starting_stock', '')::int, 0);
  v_min      int := nullif(p ->> 'min_stock', '')::int;
  v_active   boolean := coalesce((p ->> 'active')::boolean, true);
  v_changes  jsonb := '{}'::jsonb;
begin
  v_me := public._require_roles(array['admin', 'product_manager']);
  if v_name = '' then perform public._fail('BAD_REQUEST', 'Product name is required.'); end if;
  if v_price is null or v_price < 0 then perform public._fail('BAD_REQUEST', 'Selling price must be 0 or more.'); end if;
  if v_cost < 0 then perform public._fail('BAD_REQUEST', 'Cost must be 0 or more.'); end if;
  if v_start < 0 then perform public._fail('BAD_REQUEST', 'Starting stock must be 0 or more.'); end if;
  if v_min is null then
    select low_stock_default into v_min from public.app_settings where id = 1;
  end if;
  if v_min < 0 then perform public._fail('BAD_REQUEST', 'Minimum stock must be 0 or more.'); end if;
  if not exists (select 1 from public.sections where code = v_section) then
    perform public._fail('BAD_REQUEST', 'Choose a valid section.');
  end if;
  if v_cat is not null and not exists (select 1 from public.categories where id = v_cat and section_code = v_section) then
    perform public._fail('BAD_REQUEST', 'That category belongs to a different section.');
  end if;
  if not v_track then v_start := 0; v_min := 0; end if;
  if v_sku is not null and exists (select 1 from public.products where sku = v_sku and id is distinct from v_id) then
    perform public._fail('DUPLICATE', format('The code "%s" is already used by another product.', v_sku));
  end if;

  if v_id is null then
    if exists (select 1 from public.products where section_code = v_section and lower(name) = lower(v_name)) then
      perform public._fail('DUPLICATE', format('A product called "%s" already exists in this section.', v_name));
    end if;
    insert into public.products (sku, section_code, category_id, name, price, image_url, track_stock,
      starting_stock, stock, min_stock, active)
    values (v_sku, v_section, v_cat, v_name, v_price, v_image, v_track, v_start, v_start, v_min, v_active)
    returning id into v_id;
    insert into public.product_costs (product_id, cost) values (v_id, v_cost);
    if v_start > 0 then
      insert into public.stock_movements (product_id, section_code, movement_type, quantity_change,
        stock_before, stock_after, created_by, reason)
      values (v_id, v_section, 'initial', v_start, 0, v_start, v_me.id, 'Starting stock');
    end if;
    perform public._audit('product_created', v_section, 'product', v_id::text,
      jsonb_build_object('name', v_name, 'price', v_price, 'cost', v_cost, 'starting_stock', v_start,
        'min_stock', v_min, 'category_id', v_cat, 'track_stock', v_track, 'active', v_active));
    return v_id;
  end if;

  -- update
  select * into v_old from public.products where id = v_id for update;
  if not found then perform public._fail('NOT_FOUND', 'Product not found.'); end if;
  select cost into v_old_cost from public.product_costs where product_id = v_id;
  if v_track <> v_old.track_stock and v_old.stock <> 0 then
    perform public._fail('BAD_REQUEST', 'Remove all stock (set it to 0 with a stock adjustment) before changing stock tracking.');
  end if;
  if exists (select 1 from public.products where section_code = v_section and lower(name) = lower(v_name) and id <> v_id) then
    perform public._fail('DUPLICATE', format('A product called "%s" already exists in this section.', v_name));
  end if;

  if v_old.name is distinct from v_name then v_changes := v_changes || jsonb_build_object('name', jsonb_build_array(v_old.name, v_name)); end if;
  if v_old.sku is distinct from v_sku then v_changes := v_changes || jsonb_build_object('sku', jsonb_build_array(v_old.sku, v_sku)); end if;
  if v_old.section_code is distinct from v_section then v_changes := v_changes || jsonb_build_object('section_code', jsonb_build_array(v_old.section_code, v_section)); end if;
  if v_old.category_id is distinct from v_cat then v_changes := v_changes || jsonb_build_object('category_id', jsonb_build_array(v_old.category_id, v_cat)); end if;
  if v_old.image_url is distinct from v_image then v_changes := v_changes || jsonb_build_object('image_url', jsonb_build_array(v_old.image_url, v_image)); end if;
  if v_old.track_stock is distinct from v_track then v_changes := v_changes || jsonb_build_object('track_stock', jsonb_build_array(v_old.track_stock, v_track)); end if;
  if v_old.min_stock is distinct from v_min then v_changes := v_changes || jsonb_build_object('min_stock', jsonb_build_array(v_old.min_stock, v_min)); end if;
  if v_old.active is distinct from v_active then v_changes := v_changes || jsonb_build_object('active', jsonb_build_array(v_old.active, v_active)); end if;

  -- starting_stock / stock are NOT editable here: stock changes only through
  -- sales, voids and admin_adjust_stock (which require a reason).
  update public.products
     set sku = v_sku, section_code = v_section, category_id = v_cat, name = v_name, price = v_price,
         image_url = v_image, track_stock = v_track, min_stock = v_min, active = v_active
   where id = v_id;
  update public.product_costs set cost = v_cost where product_id = v_id;

  if v_old.price <> v_price then
    perform public._audit('price_changed', v_section, 'product', v_id::text,
      jsonb_build_object('name', v_name, 'from', v_old.price, 'to', v_price));
  end if;
  if v_old_cost is distinct from v_cost then
    perform public._audit('cost_changed', v_section, 'product', v_id::text,
      jsonb_build_object('name', v_name, 'from', v_old_cost, 'to', v_cost));
  end if;
  if v_changes <> '{}'::jsonb then
    perform public._audit(case when v_changes ? 'active' and (select count(*) from jsonb_object_keys(v_changes)) = 1
                               then case when v_active then 'product_activated' else 'product_deactivated' end
                               else 'product_updated' end,
      v_section, 'product', v_id::text, jsonb_build_object('name', v_name, 'changes', v_changes));
  end if;
  return v_id;
end $$;

create or replace function public.admin_save_product(p jsonb) returns bigint
language plpgsql security definer set search_path='' as $$
declare v_id bigint; v_stock int; v_old public.products; v_cost numeric; v_p jsonb;
begin
 perform public._require_roles(array['admin','product_manager']);
 if not exists(select 1 from public.money_start) then
  if nullif(p->>'funding_key','') is not null and coalesce((p->>'starting_stock')::int,0)>0 then perform public._money_ready(); end if;
  return public._save_product_original(p);
 end if;
 if nullif(p->>'id','') is not null then
  select * into v_old from public.products where id=(p->>'id')::bigint for update;
  select cost into v_cost from public.product_costs where product_id=v_old.id;
  if v_old.stock>0 and coalesce((p->>'cost')::numeric,0) is distinct from v_cost then
   perform public._fail('COST_MANAGED','Cost is averaged from stock purchases. Receive new stock with its actual buying price.');
  end if;
  return public._save_product_original(p);
 end if;
 v_stock:=case when coalesce((p->>'track_stock')::boolean,true) then coalesce((p->>'starting_stock')::int,0) else 0 end;
 if v_stock<0 then perform public._fail('BAD_QUANTITY','Starting stock cannot be negative.'); end if;
 if v_stock=0 then return public._save_product_original(p); end if;
 if not (p ? 'funding_key') or not (p ? 'no_spend') then
  perform public._fail('PAYMENT_REQUIRED','Choose a payment account or no money spent for the starting stock.');
 end if;
 -- Guard creation retries, including a lost response after the product exists.
 if not public._money_claim((p->>'funding_key')::uuid,jsonb_build_object('kind','new_product','product',p)) then
  return (select (result->>'product_id')::bigint from public.money_actions where id=(p->>'funding_key')::uuid);
 end if;
 v_p:=p||jsonb_build_object('starting_stock',0);
 v_id:=public._save_product_original(v_p);
 perform public.money_stock(gen_random_uuid(),v_id,'add',v_stock,'Initial stock purchase',
  case when (p->>'no_spend')::boolean then null else coalesce((p->>'cost')::numeric,0) end,
  (p->>'payment_account')::public.payment_method,(p->>'no_spend')::boolean,null);
 update public.money_actions set result=jsonb_build_object('product_id',v_id) where id=(p->>'funding_key')::uuid;
 return v_id;
end $$;

create or replace function public.admin_import_products(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb; v_cat bigint; v_created int := 0; v_cats int := 0; v_skipped jsonb := '[]'::jsonb;
  v_section text; v_catname text;
begin
  perform public._require_roles(array['admin', 'product_manager']);
  if jsonb_typeof(p_rows) is distinct from 'array' then perform public._fail('BAD_REQUEST', 'Expected a list of products.'); end if;
  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_section := v_row ->> 'section_code';
    v_catname := nullif(trim(coalesce(v_row ->> 'category', '')), '');
    if exists (select 1 from public.products where section_code = v_section and lower(name) = lower(trim(v_row ->> 'name'))) then
      v_skipped := v_skipped || to_jsonb(v_row ->> 'name');
      continue;
    end if;
    v_cat := null;
    if v_catname is not null then
      select id into v_cat from public.categories where section_code = v_section and lower(name) = lower(v_catname);
      if v_cat is null then
        v_cat := public.admin_save_category(null, v_section, v_catname, 0, true);
        v_cats := v_cats + 1;
      end if;
    end if;
    perform public.admin_save_product(jsonb_build_object(
      'section_code', v_section, 'category_id', v_cat, 'name', v_row ->> 'name',
      -- keep the old code unless another product already uses it
      'sku', case when exists (select 1 from public.products where sku = v_row ->> 'sku') then null else v_row ->> 'sku' end,
      'price', v_row -> 'price', 'cost', coalesce(v_row -> 'cost', '0'::jsonb), 'image_url', v_row ->> 'image_url',
      'track_stock', coalesce(v_row -> 'track_stock', 'true'::jsonb),
      'starting_stock', coalesce(v_row -> 'stock', '0'::jsonb), 'min_stock', v_row -> 'min_stock',
      'funding_key',v_row->'funding_key','no_spend',v_row->'no_spend','payment_account',v_row->'payment_account',
      'active', coalesce(v_row -> 'active', 'true'::jsonb)));
    v_created := v_created + 1;
  end loop;
  perform public._audit('products_imported', null, 'product', null,
    jsonb_build_object('created', v_created, 'categories_created', v_cats, 'skipped', v_skipped));
  return jsonb_build_object('created', v_created, 'categories_created', v_cats, 'skipped', v_skipped);
end $$;

revoke all on function public._money_lock(),public._money_ready(),public._money_amount(numeric,boolean),
 public._money_funds(public.payment_method,numeric),public._money_claim(uuid,jsonb),public._money_sale(),
 public._stock_adjust_original(bigint,text,int,text),public._receive_supplier_original(uuid,bigint,int),public._save_product_original(jsonb),
 public.money_open(uuid,numeric,numeric,numeric),public.money_record(uuid,text,public.payment_method,numeric,text,public.payment_method),
 public.money_summary(),public.money_stock(uuid,bigint,text,int,text,numeric,public.payment_method,boolean,bigint)
 from public,anon,authenticated;
grant execute on function public.money_open(uuid,numeric,numeric,numeric),
 public.money_record(uuid,text,public.payment_method,numeric,text,public.payment_method),public.money_summary(),
 public.money_stock(uuid,bigint,text,int,text,numeric,public.payment_method,boolean,bigint) to authenticated;
create or replace function public.admin_decide_void(p_request_id bigint, p_approve boolean, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me  public.profiles;
  v_req public.void_requests;
  v_txn public.transactions;
  r     record;
  v_after int;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  v_me := public._require_admin();

  select * into v_req from public.void_requests where id = p_request_id for update;
  if not found then
    perform public._fail('NOT_FOUND', 'Void request not found.');
  end if;
  if v_req.status <> 'pending' then
    perform public._fail('ALREADY_DECIDED', format('This request was already %s.', v_req.status));
  end if;

  if not p_approve then
    update public.void_requests
       set status = 'rejected', decided_by = v_me.id, decided_at = now(), decision_note = v_note
     where id = v_req.id;
    perform public._audit('void_rejected', v_req.section_code, 'transaction', v_req.transaction_id::text,
      jsonb_build_object('void_request_id', v_req.id, 'note', v_note));
    return jsonb_build_object('void_request_id', v_req.id, 'status', 'rejected');
  end if;

  select * into v_txn from public.transactions where id = v_req.transaction_id for update;
  if v_txn.status <> 'completed' then
    perform public._fail('ALREADY_VOIDED', 'This transaction is already voided.');
  end if;

  perform 1 from public.products where id in (
    select product_id from public.stock_movements where transaction_id=v_txn.id and movement_type='sale'
  ) order by id for update;
  update public.transactions
     set status = 'voided', voided_at = now(), voided_by = v_me.id, void_reason = v_req.reason
   where id = v_txn.id;

  -- restore exactly what the sale deducted (only products that had a 'sale' movement)
  for r in
    select m.product_id, -m.quantity_change as qty
    from public.stock_movements m
    where m.transaction_id = v_txn.id and m.movement_type = 'sale'
    order by m.product_id
  loop
    update public.products set stock = stock + r.qty where id = r.product_id returning stock into v_after;
    insert into public.stock_movements (product_id, section_code, movement_type, quantity_change, stock_before,
      stock_after, transaction_id, void_request_id, created_by, reason)
    values (r.product_id, v_txn.section_code, 'void_restore', r.qty, v_after - r.qty, v_after, v_txn.id, v_req.id,
      v_me.id, 'Void of ' || v_txn.txn_no);
  end loop;

  update public.void_requests
     set status = 'approved', decided_by = v_me.id, decided_at = now(), decision_note = v_note
   where id = v_req.id;

  perform public._audit('void_approved', v_txn.section_code, 'transaction', v_txn.id::text,
    jsonb_build_object('txn_no', v_txn.txn_no, 'void_request_id', v_req.id, 'refund_amount', v_txn.total,
      'payment_method', v_txn.payment_method, 'note', v_note));
  return jsonb_build_object('void_request_id', v_req.id, 'status', 'approved', 'refund_amount', v_txn.total);
end $$;

-- Returned units recover their original sale-time cost in the inventory average.
create function public._money_restore_cost() returns trigger language plpgsql security definer set search_path='' as $$
declare v_unit numeric;
begin
 if new.movement_type='void_restore' and exists(select 1 from public.money_start) then
  select unit_cost into v_unit from public.transaction_items where transaction_id=new.transaction_id and product_id=new.product_id;
  update public.product_costs set cost=round((new.stock_before*cost+new.quantity_change*v_unit)/new.stock_after,2) where product_id=new.product_id;
 end if;
 return new;
end $$;
create trigger money_restore_cost after insert on public.stock_movements for each row execute function public._money_restore_cost();
revoke all on function public._money_restore_cost() from public,anon,authenticated;
create trigger money_ledger_no_truncate before truncate on public.money_ledger for each statement execute function public.forbid_change();
create trigger money_start_no_truncate before truncate on public.money_start for each statement execute function public.forbid_change();

notify pgrst,'reload schema';
$migration$; end if; end $upgrade$;


-- Block concurrent writes while removing all linked event records.
lock table public.profiles, public.products, public.product_costs, public.categories,
 public.transactions, public.transaction_items, public.void_requests,
 public.cash_handovers, public.stock_movements, public.supplier_orders,
 public.supplier_order_items, public.supplier_receipts, public.money_start,
 public.money_actions, public.money_ledger, public.audit_logs in access exclusive mode;

create temporary table launch_preserved_admin on commit drop as
 select u.id from auth.users u join public.profiles p on p.id=u.id
 where lower(u.email)='yassinziada@gmail.com' and p.role='admin' and p.active;

do $reset$
declare v_admin uuid; v_before jsonb; r record;
begin
 select id into strict v_admin from launch_preserved_admin;
 -- Recheck after taking locks to make concurrent/accidental replay safe.
 if exists(select 1 from public.audit_logs where action='fundraiser_prelaunch_reset'
   and details->>'reset_id'='live-launch-2026-11-07') then
  raise exception 'STOP: launch reset already completed.';
 end if;
 v_before:=jsonb_build_object(
  'transactions_removed',(select count(*) from public.transactions),
  'accounts_removed',(select count(*) from auth.users where id<>v_admin),
  'products_kept',(select count(*) from public.products),
  'categories_kept',(select count(*) from public.categories),
  'stock_units_cleared',(select coalesce(sum(stock),0) from public.products),
  'reset_id','live-launch-2026-11-07');

 -- Only the named append-only DELETE guards are disabled, inside this transaction.
 -- RLS, authentication, FK constraints and all other triggers stay enabled.
 for r in select * from (values
  ('money_ledger','money_ledger_immutable'),('money_start','money_start_immutable'),
  ('supplier_receipts','supplier_receipts_immutable'),
  ('stock_movements','stock_movements_no_update'),('transaction_items','transaction_items_no_update'),
  ('transactions','transactions_guard'),('void_requests','void_requests_guard'),
  ('cash_handovers','cash_handovers_guard'),('audit_logs','audit_logs_no_update')
 ) as guards(tbl,trig) loop
  execute format('alter table public.%I disable trigger %I',r.tbl,r.trig);
 end loop;
 delete from public.money_ledger;
 delete from public.money_start;
 delete from public.money_actions;
 delete from public.supplier_receipts;
 delete from public.supplier_order_items;
 delete from public.supplier_orders;
 delete from public.stock_movements;
 delete from public.cash_handovers;
 delete from public.void_requests;
 delete from public.transaction_items;
 delete from public.transactions;
 delete from public.audit_logs;
 update public.products set stock=0,starting_stock=0;
 update public.app_settings set updated_by=null;
 delete from public.profiles where id<>v_admin;
 delete from auth.users where id<>v_admin;
 -- The active Admin UUID, credentials and metadata are unchanged.
 for r in select * from (values
  ('money_ledger','money_ledger_immutable'),('money_start','money_start_immutable'),
  ('supplier_receipts','supplier_receipts_immutable'),
  ('stock_movements','stock_movements_no_update'),('transaction_items','transaction_items_no_update'),
  ('transactions','transactions_guard'),('void_requests','void_requests_guard'),
  ('cash_handovers','cash_handovers_guard'),('audit_logs','audit_logs_no_update')
 ) as guards(tbl,trig) loop
  execute format('alter table public.%I enable trigger %I',r.tbl,r.trig);
 end loop;
 insert into public.audit_logs(actor_id,actor_name,actor_role,action,entity_type,details)
 values(v_admin,'SQL Editor launch reset','system','fundraiser_prelaunch_reset','fundraiser',v_before);
end $reset$;

notify pgrst,'reload schema';
commit;
select 'Ready: catalogue kept; stock, event data and other accounts cleared; Admin kept.' as result,
 (select count(*) from public.products) as products_kept,
 (select count(*) from public.categories) as categories_kept,
 (select count(*) from public.profiles) as accounts_remaining,
 (select count(*) from public.money_ledger) as money_entries;
