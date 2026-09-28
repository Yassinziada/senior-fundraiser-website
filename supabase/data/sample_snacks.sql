-- =============================================================================
-- OPTIONAL SAMPLE DATA for the Snacks section — for testing only.
-- Every product name starts with "[SAMPLE]" so it is obvious.
-- To remove them before the event, run data/remove_sample_snacks.sql
-- (only works while they have no sales — otherwise just deactivate them).
-- =============================================================================
do $$
declare r record; v_cat bigint; v_id bigint;
begin
  insert into public.categories (section_code, name, sort_order)
  select 'SNACKS', c.name, c.ord from (values ('Drinks', 1), ('Sweets', 2), ('Savoury', 3)) as c(name, ord)
  where not exists (select 1 from public.categories x where x.section_code = 'SNACKS' and lower(x.name) = lower(c.name));

  for r in select * from (values
    ('[SAMPLE] Water bottle', 'Drinks', 10.00, 5.00, 48),
    ('[SAMPLE] Juice box', 'Drinks', 15.00, 9.00, 36),
    ('[SAMPLE] Chocolate bar', 'Sweets', 20.00, 12.00, 30),
    ('[SAMPLE] Cupcake', 'Sweets', 25.00, 10.00, 24),
    ('[SAMPLE] Chips', 'Savoury', 15.00, 8.00, 40),
    ('[SAMPLE] Popcorn cup', 'Savoury', 20.00, 6.00, 30)
  ) as t(name, category, price, cost, stock)
  loop
    continue when exists (select 1 from public.products p where p.section_code = 'SNACKS' and lower(p.name) = lower(r.name));
    select id into v_cat from public.categories where section_code = 'SNACKS' and name = r.category;
    insert into public.products (section_code, category_id, name, price, starting_stock, stock, min_stock)
    values ('SNACKS', v_cat, r.name, r.price, r.stock, r.stock, 5) returning id into v_id;
    insert into public.product_costs (product_id, cost) values (v_id, r.cost);
    insert into public.stock_movements (product_id, section_code, movement_type, quantity_change, stock_before, stock_after, reason)
    values (v_id, 'SNACKS', 'initial', r.stock, 0, r.stock, 'Sample starting stock');
  end loop;
end $$;
