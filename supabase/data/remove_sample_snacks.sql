-- Removes the "[SAMPLE]" Snacks products created by sample_snacks.sql.
-- Refuses if any sample product has already been sold (deactivate those instead,
-- or run scripts/clear_test_data.sql first if all sales so far were tests).
begin;
do $$
begin
  if exists (select 1 from public.transaction_items i join public.products p on p.id = i.product_id
             where p.name like '[SAMPLE]%') then
    raise exception 'Sample products have sales. Deactivate them in Admin -> Products, or clear test data first.';
  end if;
end $$;
alter table public.stock_movements disable trigger stock_movements_no_update;
delete from public.stock_movements where product_id in (select id from public.products where name like '[SAMPLE]%');
alter table public.stock_movements enable trigger stock_movements_no_update;
delete from public.product_costs where product_id in (select id from public.products where name like '[SAMPLE]%');
delete from public.products where name like '[SAMPLE]%';
delete from public.categories c where c.section_code = 'SNACKS'
  and c.name in ('Drinks', 'Sweets', 'Savoury')
  and not exists (select 1 from public.products p where p.category_id = c.id);
insert into public.audit_logs (actor_name, actor_role, action, entity_type, details)
values ('SQL editor', 'system', 'sample_data_removed', 'product', '{"section": "SNACKS"}');
commit;
