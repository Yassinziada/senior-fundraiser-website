-- =============================================================================
-- School Bazaar POS — 004: product image storage + realtime
-- =============================================================================

-- Public bucket for product photos. Photos are not sensitive (customers see
-- them), so anyone may VIEW them; only active admins may upload/replace/delete.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 2097152,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "product images: admin upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'product-images' and (select public.is_admin()));
create policy "product images: admin update" on storage.objects
  for update to authenticated
  using (bucket_id = 'product-images' and (select public.is_admin()))
  with check (bucket_id = 'product-images' and (select public.is_admin()));
create policy "product images: admin delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'product-images' and (select public.is_admin()));

-- Realtime: push row changes to connected browsers. Realtime applies the same
-- RLS policies as normal reads, so cashiers only receive their own section's
-- product changes and never receive transactions/voids (admin-only tables).
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
alter publication supabase_realtime add table
  public.products, public.transactions, public.void_requests, public.cash_handovers;
