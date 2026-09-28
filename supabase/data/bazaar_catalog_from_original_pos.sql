-- =============================================================================
-- OPTIONAL: the Bazaar catalogue from the original single-file POS
-- (legacy/Bazaar-POS-original.html): 5 categories, 20 products with their
-- estimated unit cost and suggested selling price, starting stock 20,
-- minimum stock 5, plus the two face-painting services (no stock tracking).
--
-- Use EITHER this file OR the in-app importer (Admin -> Import) with a backup
-- file from the old POS, which also brings over your edited prices, stock
-- and photos. Products that already exist (same name) are skipped, so the
-- file is safe to run twice. No transactions are imported.
-- Run AFTER the migrations and seed.sql.
-- =============================================================================
do $$
declare
  r record; v_cat bigint; v_id bigint;
begin
  insert into public.categories (section_code, name, sort_order)
  select 'BAZAAR', c.name, c.ord
  from (values ('Accessories', 1), ('Stationery', 2), ('Toys & Games', 3), ('Handmade', 4), ('Services', 5)) as c(name, ord)
  where not exists (select 1 from public.categories x where x.section_code = 'BAZAAR' and lower(x.name) = lower(c.name));

  for r in select * from (values
  ('BZ-P001', 'Phone charms', 'Accessories', 50.00, 25.00, true, 20, 5),
  ('BZ-P002', 'Custom stickers', 'Stationery', 20.00, 10.00, true, 20, 5),
  ('BZ-P003', 'Claw clips', 'Accessories', 40.00, 25.00, true, 20, 5),
  ('BZ-P004', 'Pencil toppers', 'Stationery', 15.00, 7.00, true, 20, 5),
  ('BZ-P005', 'Cute erasers', 'Stationery', 15.00, 6.00, true, 20, 5),
  ('BZ-P006', 'Gel pens', 'Stationery', 15.00, 6.00, true, 20, 5),
  ('BZ-P007', 'Mini notebooks', 'Stationery', 40.00, 20.00, true, 20, 5),
  ('BZ-P008', 'Keychains', 'Accessories', 40.00, 20.00, true, 20, 5),
  ('BZ-P009', 'Friendship bracelets', 'Accessories', 30.00, 15.00, true, 20, 5),
  ('BZ-P010', 'Crochet items', 'Handmade', 80.00, 40.00, true, 20, 5),
  ('BZ-P011', 'Scrunchies', 'Accessories', 30.00, 15.00, true, 20, 5),
  ('BZ-P012', 'Highlighters', 'Stationery', 20.00, 10.00, true, 20, 5),
  ('BZ-P013', 'Mini rulers', 'Stationery', 10.00, 6.00, true, 20, 5),
  ('BZ-P014', 'Erasers', 'Stationery', 10.00, 6.00, true, 20, 5),
  ('BZ-P015', 'Pencil cases', 'Stationery', 60.00, 30.00, true, 20, 5),
  ('BZ-P016', 'Squishy toys', 'Toys & Games', 50.00, 20.00, true, 20, 5),
  ('BZ-P017', 'Fidget toys', 'Toys & Games', 50.00, 25.00, true, 20, 5),
  ('BZ-P018', 'Stress balls', 'Toys & Games', 40.00, 20.00, true, 20, 5),
  ('BZ-P019', 'Rubik''s cubes', 'Toys & Games', 70.00, 35.00, true, 20, 5),
  ('BZ-P020', 'Caps', 'Accessories', 130.00, 70.00, true, 20, 5),
  ('BZ-P021', 'Face painting (small design)', 'Services', 30.00, 5.00, false, 0, 0),
  ('BZ-P022', 'Face painting (full face)', 'Services', 60.00, 10.00, false, 0, 0)
  ) as t(sku, name, category, price, cost, track_stock, stock, min_stock)
  loop
    continue when exists (select 1 from public.products p where p.section_code = 'BAZAAR' and lower(p.name) = lower(r.name));
    select id into v_cat from public.categories where section_code = 'BAZAAR' and name = r.category;
    insert into public.products (sku, section_code, category_id, name, price, track_stock, starting_stock, stock, min_stock)
    values (r.sku, 'BAZAAR', v_cat, r.name, r.price, r.track_stock, r.stock, r.stock, r.min_stock)
    returning id into v_id;
    insert into public.product_costs (product_id, cost) values (v_id, r.cost);
    if r.stock > 0 then
      insert into public.stock_movements (product_id, section_code, movement_type, quantity_change, stock_before, stock_after, reason)
      values (v_id, 'BAZAAR', 'initial', r.stock, 0, r.stock, 'Starting stock (seed from original POS)');
    end if;
  end loop;

  insert into public.audit_logs (actor_name, actor_role, action, entity_type, details)
  values ('SQL editor', 'system', 'products_seeded', 'product', '{"source": "original single-file POS catalogue"}');
end $$;
