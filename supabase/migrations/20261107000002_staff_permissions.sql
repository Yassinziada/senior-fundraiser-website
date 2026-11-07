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
