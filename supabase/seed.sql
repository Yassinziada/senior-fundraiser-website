-- =============================================================================
-- REQUIRED base data: the two sections and the settings row.
-- Safe to run more than once.
-- =============================================================================
insert into public.sections (code, name, txn_prefix, sort_order) values
  ('BAZAAR', 'Bazaar', 'BZR', 1),
  ('SNACKS', 'Snacks', 'SNK', 2)
on conflict (code) do nothing;

insert into public.app_settings (id) values (1) on conflict (id) do nothing;
