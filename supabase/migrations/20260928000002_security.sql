-- =============================================================================
-- School Bazaar POS — 002: authentication link, role helpers, Row Level Security
--
-- SECURITY MODEL (read this before changing anything)
--   * The browser holds only the public anon/publishable key. Anyone can see
--     it, so it grants nothing by itself.
--   * Every request carries the signed-in user's JWT. auth.uid() identifies
--     them; public.profiles says whether they are an ACTIVE admin or an ACTIVE
--     cashier of exactly one section.
--   * READS: Row Level Security policies below. Cashiers can read only
--       - the section list and app settings (non-sensitive),
--       - their own profile row,
--       - ACTIVE categories/products of THEIR OWN section.
--     products has no cost column (cost lives in product_costs, admin-only),
--     so there is no column a cashier could use to learn cost or profit.
--     Transactions, items (with cost snapshots), voids, stock movements,
--     handovers and the audit log are admin-only tables; cashiers reach their
--     own recent sales only through pos_my_transactions(), which returns no
--     cost fields.
--   * WRITES: the API roles (anon, authenticated) get NO insert/update/delete
--     privilege on any table. Every change goes through a SECURITY DEFINER
--     function (003_functions.sql) that checks the caller's role and section
--     itself and writes the audit log in the same database transaction.
-- =============================================================================

-- ---------- role helpers ----------------------------------------------------
-- SECURITY DEFINER so they can read profiles regardless of the caller's RLS;
-- they only ever answer questions about the caller (auth.uid()).
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active and p.role = 'admin'
  );
$$;

create or replace function public.my_cashier_section()
returns text language sql stable security definer set search_path = '' as $$
  select p.section_code from public.profiles p
  where p.id = auth.uid() and p.active and p.role = 'cashier';
$$;

-- ---------- event timezone helpers -------------------------------------------
create or replace function public.app_timezone()
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select s.timezone from public.app_settings s where s.id = 1), 'Africa/Cairo');
$$;

create or replace function public.business_date_of(p_ts timestamptz)
returns date language sql stable security definer set search_path = '' as $$
  select (p_ts at time zone public.app_timezone())::date;
$$;

-- first instant of a business day in the event timezone
create or replace function public.business_day_start(p_date date)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select (p_date::timestamp at time zone public.app_timezone());
$$;

-- ---------- link Supabase Auth users to profiles -----------------------------
-- Runs whenever a user is created in auth.users (by the admin-users Edge
-- Function, or manually in the Supabase dashboard).
-- raw_app_meta_data can ONLY be written with the service-role key, never by a
-- user signing themselves up, so it is safe to read the role from it. Users
-- without our pos_* metadata (e.g. created in the dashboard, or via public
-- sign-up if someone forgot to disable it) become INACTIVE profiles with no
-- access until an admin activates them.
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
  if v_meta ->> 'pos_role' in ('admin', 'cashier') then
    v_role := (v_meta ->> 'pos_role')::public.app_role;
    v_section := case when v_role = 'cashier' then nullif(v_meta ->> 'pos_section', '') end;
    if v_role = 'admin' or exists (select 1 from public.sections s where s.code = v_section) then
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

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- =============================================================================
-- Row Level Security
-- (select public.is_admin()) is wrapped in a sub-select so Postgres evaluates
-- it once per query instead of once per row.
-- =============================================================================
alter table public.sections          enable row level security;
alter table public.app_settings      enable row level security;
alter table public.profiles          enable row level security;
alter table public.categories        enable row level security;
alter table public.products          enable row level security;
alter table public.product_costs     enable row level security;
alter table public.transactions      enable row level security;
alter table public.transaction_items enable row level security;
alter table public.void_requests     enable row level security;
alter table public.stock_movements   enable row level security;
alter table public.cash_handovers    enable row level security;
alter table public.audit_logs        enable row level security;

-- sections & settings: any signed-in ACTIVE user (nothing sensitive)
create policy sections_read on public.sections for select to authenticated
  using ((select public.is_admin()) or (select public.my_cashier_section()) is not null);
create policy app_settings_read on public.app_settings for select to authenticated
  using ((select public.is_admin()) or (select public.my_cashier_section()) is not null);

-- profiles: everyone sees their own row (even if inactive, so the app can say
-- "account inactive"); admins see all
create policy profiles_read_own on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy profiles_read_admin on public.profiles for select to authenticated
  using ((select public.is_admin()));

-- categories / products: admins everything; cashiers only ACTIVE rows of their section
create policy categories_read_admin on public.categories for select to authenticated
  using ((select public.is_admin()));
create policy categories_read_cashier on public.categories for select to authenticated
  using (active and section_code = (select public.my_cashier_section()));

create policy products_read_admin on public.products for select to authenticated
  using ((select public.is_admin()));
create policy products_read_cashier on public.products for select to authenticated
  using (active and section_code = (select public.my_cashier_section()));

-- admin-only tables
create policy product_costs_admin on public.product_costs for select to authenticated
  using ((select public.is_admin()));
create policy transactions_admin on public.transactions for select to authenticated
  using ((select public.is_admin()));
create policy transaction_items_admin on public.transaction_items for select to authenticated
  using ((select public.is_admin()));
create policy void_requests_admin on public.void_requests for select to authenticated
  using ((select public.is_admin()));
create policy stock_movements_admin on public.stock_movements for select to authenticated
  using ((select public.is_admin()));
create policy cash_handovers_admin on public.cash_handovers for select to authenticated
  using ((select public.is_admin()));
create policy audit_logs_admin on public.audit_logs for select to authenticated
  using ((select public.is_admin()));

-- =============================================================================
-- Table privileges
-- Supabase grants ALL on new public tables to anon/authenticated by default.
-- Take everything away, then give back SELECT only (still filtered by RLS).
-- No API role can INSERT/UPDATE/DELETE any table directly.
-- =============================================================================
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on
  public.sections, public.app_settings, public.profiles, public.categories,
  public.products, public.product_costs, public.transactions, public.transaction_items,
  public.void_requests, public.stock_movements, public.cash_handovers, public.audit_logs
to authenticated;

-- future tables/sequences created by migrations must opt in explicitly
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
