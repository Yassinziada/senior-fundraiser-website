-- =============================================================================
-- FIRST ADMIN — run once in Supabase Dashboard -> SQL Editor.
--
-- 1. Authentication -> Users -> "Add user" -> "Create new user"
--      Email:    your real email (e.g. coordinator@yourschool.org)
--      Password: a strong password (12+ characters)
--      [x] Auto Confirm User
-- 2. Replace the email below with the one you used, then click Run.
-- =============================================================================
select public.make_admin('coordinator@yourschool.org');
