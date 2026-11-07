-- STEP 1: run alone in the OLD LIVE project bpyqftcwmikfrqfpsemz.
-- Adds role names only. Commit before running Step 2. Safe to rerun.
-- Commit these enum additions before using the new roles.
alter type public.app_role add value if not exists 'finance';
alter type public.app_role add value if not exists 'product_manager';
alter type public.app_role add value if not exists 'supplier';
