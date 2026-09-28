-- =============================================================================
-- School Bazaar POS — 001: core relational schema
--
-- Design rules
--   * Money is numeric(12,2). Never float.
--   * Every sales/inventory record carries its section (BAZAAR / SNACKS).
--   * Ledger tables (transactions, items, stock movements, voids, handovers,
--     audit log) are append-only: triggers below block deletes and any update
--     that is not an allowed state transition.
--   * Clients never write to tables directly. All writes go through the
--     SECURITY DEFINER functions in 003_functions.sql (see 002_security.sql).
-- =============================================================================

-- ---------- enums -----------------------------------------------------------
create type public.app_role as enum ('admin', 'cashier');
create type public.payment_method as enum ('CASH', 'TELDA', 'INSTAPAY');
create type public.transaction_status as enum ('completed', 'voided');
create type public.void_status as enum ('pending', 'approved', 'rejected');
create type public.stock_movement_type as enum (
  'initial',        -- starting stock when the product was created
  'sale',           -- decreased by a completed sale
  'void_restore',   -- returned to stock by an approved void
  'adjust_add',     -- manual admin adjustment (+) with reason
  'adjust_remove'   -- manual admin adjustment (-) with reason
);

-- ---------- generic helpers -------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------- sections --------------------------------------------------------
create table public.sections (
  code        text primary key check (code ~ '^[A-Z][A-Z_]{1,19}$'),
  name        text not null check (length(trim(name)) between 1 and 40),
  txn_prefix  text not null unique check (txn_prefix ~ '^[A-Z]{1,5}$'),
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now()
);

-- ---------- application settings (single row) -------------------------------
create table public.app_settings (
  id                    smallint primary key default 1 check (id = 1),
  event_name            text not null default 'School Bazaar'
                          check (length(trim(event_name)) between 1 and 120),
  currency_code         text not null default 'EGP' check (currency_code ~ '^[A-Z]{3}$'),
  locale                text not null default 'en-EG' check (locale ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  timezone              text not null default 'Africa/Cairo',
  low_stock_default     int  not null default 5 check (low_stock_default between 0 and 100000),
  receipt_header        text not null default '' check (length(receipt_header) <= 300),
  receipt_footer        text not null default 'Thank you for supporting our school!'
                          check (length(receipt_footer) <= 300),
  receipt_show_cashier  boolean not null default true,
  updated_at            timestamptz not null default now(),
  updated_by            uuid
);

-- ---------- user profiles ---------------------------------------------------
-- One row per Supabase Auth user. Credentials live ONLY in auth.users
-- (bcrypt-hashed by Supabase); nothing secret is stored here.
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete restrict,
  username      text not null unique check (username ~ '^[a-z0-9._-]{2,40}$'),
  login_email   text not null,
  full_name     text not null default '' check (length(full_name) <= 80),
  role          public.app_role not null default 'cashier',
  section_code  text references public.sections (code),
  active        boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- an ACTIVE cashier must be assigned to exactly one section
  constraint profiles_cashier_section check (role <> 'cashier' or section_code is not null or not active),
  -- admins are global, never tied to one section
  constraint profiles_admin_no_section check (role <> 'admin' or section_code is null)
);
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ---------- categories ------------------------------------------------------
create table public.categories (
  id            bigint generated always as identity primary key,
  section_code  text not null references public.sections (code),
  name          text not null check (length(trim(name)) between 1 and 60),
  sort_order    int  not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- lets products reference (category, section) so a product can never sit in
  -- a category belonging to the other section
  unique (id, section_code)
);
create unique index categories_section_name_uq on public.categories (section_code, lower(name));
create trigger categories_touch before update on public.categories
  for each row execute function public.touch_updated_at();

-- ---------- products --------------------------------------------------------
-- NOTE: unit cost is deliberately NOT in this table. It lives in
-- product_costs, which only admins can read. Cashiers may read their own
-- section's active products, so this table must never contain cost/profit.
create table public.products (
  id              bigint generated always as identity primary key,
  sku             text unique check (sku is null or length(sku) between 1 and 40),
  section_code    text not null references public.sections (code),
  category_id     bigint,
  name            text not null check (length(trim(name)) between 1 and 120),
  price           numeric(12,2) not null check (price >= 0),
  image_url       text check (image_url is null or length(image_url) <= 1000),
  -- track_stock = false is for services (e.g. face painting) that never run out
  track_stock     boolean not null default true,
  starting_stock  int not null default 0 check (starting_stock >= 0),
  stock           int not null default 0 check (stock >= 0),
  min_stock       int not null default 0 check (min_stock >= 0),
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (category_id, section_code) references public.categories (id, section_code),
  constraint products_service_no_stock check (track_stock or (stock = 0 and starting_stock = 0))
);
create index products_section_idx on public.products (section_code, active);
create unique index products_section_name_uq on public.products (section_code, lower(name));
create trigger products_touch before update on public.products
  for each row execute function public.touch_updated_at();

create table public.product_costs (
  product_id  bigint primary key references public.products (id),
  cost        numeric(12,2) not null default 0 check (cost >= 0),
  updated_at  timestamptz not null default now()
);
create trigger product_costs_touch before update on public.product_costs
  for each row execute function public.touch_updated_at();

-- ---------- transactions ----------------------------------------------------
create sequence public.transaction_no_seq;

create table public.transactions (
  id               uuid primary key default gen_random_uuid(),
  txn_no           text not null unique,               -- human readable, e.g. BZR-000123
  idempotency_key  uuid not null unique,               -- duplicate-checkout protection
  section_code     text not null references public.sections (code),
  cashier_id       uuid not null references public.profiles (id),
  created_at       timestamptz not null default now(),
  business_date    date not null,                      -- event-timezone date of the sale
  item_count       int not null check (item_count > 0),
  total            numeric(12,2) not null check (total >= 0),
  total_cost       numeric(12,2) not null check (total_cost >= 0),
  payment_method   public.payment_method not null,
  amount_received  numeric(12,2),
  change_given     numeric(12,2),
  status           public.transaction_status not null default 'completed',
  voided_at        timestamptz,
  voided_by        uuid references public.profiles (id),
  void_reason      text,
  constraint transactions_cash_fields check (
    (payment_method = 'CASH'
       and amount_received is not null
       and amount_received >= total
       and change_given = amount_received - total)
    or
    (payment_method <> 'CASH' and amount_received is null and change_given is null)
  ),
  constraint transactions_void_fields check (
    (status = 'voided') = (voided_at is not null and voided_by is not null)
  )
);
create index transactions_date_idx on public.transactions (business_date, section_code);
create index transactions_created_idx on public.transactions (created_at desc);
create index transactions_cashier_idx on public.transactions (cashier_id, business_date);

create table public.transaction_items (
  id              bigint generated always as identity primary key,
  transaction_id  uuid not null references public.transactions (id),
  section_code    text not null references public.sections (code),
  product_id      bigint not null references public.products (id),
  product_name    text not null,            -- snapshot at time of sale
  category_name   text,                     -- snapshot at time of sale
  quantity        int not null check (quantity > 0),
  unit_price      numeric(12,2) not null check (unit_price >= 0),  -- price AT TIME OF SALE
  unit_cost       numeric(12,2) not null check (unit_cost >= 0),   -- cost AT TIME OF SALE
  line_total      numeric(12,2) not null,
  line_cost       numeric(12,2) not null,
  constraint transaction_items_line_total check (line_total = unit_price * quantity),
  constraint transaction_items_line_cost check (line_cost = unit_cost * quantity),
  unique (transaction_id, product_id)
);
create index transaction_items_product_idx on public.transaction_items (product_id);

-- ---------- void requests ---------------------------------------------------
create table public.void_requests (
  id              bigint generated always as identity primary key,
  transaction_id  uuid not null references public.transactions (id),
  section_code    text not null references public.sections (code),
  requested_by    uuid not null references public.profiles (id),
  reason          text not null check (length(trim(reason)) between 3 and 500),
  status          public.void_status not null default 'pending',
  requested_at    timestamptz not null default now(),
  decided_by      uuid references public.profiles (id),
  decided_at      timestamptz,
  decision_note   text check (decision_note is null or length(decision_note) <= 500),
  constraint void_requests_decision check ((status = 'pending') = (decided_by is null and decided_at is null))
);
-- at most one open request and at most one approval per transaction
create unique index void_requests_one_pending on public.void_requests (transaction_id) where status = 'pending';
create unique index void_requests_one_approved on public.void_requests (transaction_id) where status = 'approved';
create index void_requests_status_idx on public.void_requests (status, requested_at desc);

-- ---------- stock movements -------------------------------------------------
create table public.stock_movements (
  id               bigint generated always as identity primary key,
  product_id       bigint not null references public.products (id),
  section_code     text not null references public.sections (code),
  movement_type    public.stock_movement_type not null,
  quantity_change  int not null check (quantity_change <> 0),
  stock_before     int not null check (stock_before >= 0),
  stock_after      int not null check (stock_after >= 0),
  reason           text check (reason is null or length(reason) <= 500),
  transaction_id   uuid references public.transactions (id),
  void_request_id  bigint references public.void_requests (id),
  created_by       uuid references public.profiles (id),
  created_at       timestamptz not null default now(),
  constraint stock_movements_arith check (stock_after = stock_before + quantity_change),
  constraint stock_movements_sign check (
    (movement_type in ('sale', 'adjust_remove') and quantity_change < 0)
    or (movement_type in ('initial', 'void_restore', 'adjust_add') and quantity_change > 0)
  ),
  constraint stock_movements_reason check (
    movement_type not in ('adjust_add', 'adjust_remove') or length(trim(coalesce(reason, ''))) >= 3
  ),
  constraint stock_movements_txn check (
    movement_type not in ('sale', 'void_restore') or transaction_id is not null
  )
);
-- DATABASE-LEVEL GUARANTEE: a sale deducts, and a void restores, each product
-- of a transaction at most once — even if application code were buggy.
create unique index stock_movements_sale_once
  on public.stock_movements (transaction_id, product_id) where movement_type = 'sale';
create unique index stock_movements_void_restore_once
  on public.stock_movements (transaction_id, product_id) where movement_type = 'void_restore';
create index stock_movements_product_idx on public.stock_movements (product_id, created_at desc);
create index stock_movements_created_idx on public.stock_movements (created_at desc);

-- ---------- end-of-day cash handovers ---------------------------------------
create table public.cash_handovers (
  id                 bigint generated always as identity primary key,
  business_date      date not null,
  section_code       text not null references public.sections (code),
  cashier_id         uuid not null references public.profiles (id),
  cash_sales         numeric(12,2) not null,   -- CASH sales made that day
  cash_refunds       numeric(12,2) not null,   -- CASH sales voided (approved) that day
  telda_sales        numeric(12,2) not null,   -- informational, NOT physical cash
  instapay_sales     numeric(12,2) not null,   -- informational, NOT physical cash
  transaction_count  int not null,
  expected_cash      numeric(12,2) not null,
  actual_cash        numeric(12,2) not null check (actual_cash >= 0),
  difference         numeric(12,2) not null,
  notes              text check (notes is null or length(notes) <= 500),
  recorded_by        uuid not null references public.profiles (id),
  recorded_at        timestamptz not null default now(),
  superseded_at      timestamptz,             -- set when a corrected count replaces this one
  constraint cash_handovers_expected check (expected_cash = cash_sales - cash_refunds),
  constraint cash_handovers_difference check (difference = actual_cash - expected_cash)
);
create unique index cash_handovers_current_uq
  on public.cash_handovers (business_date, section_code, cashier_id) where superseded_at is null;

-- ---------- audit log -------------------------------------------------------
create table public.audit_logs (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  actor_id      uuid,
  actor_name    text,
  actor_role    text,
  action        text not null,
  section_code  text,
  entity_type   text,
  entity_id     text,
  details       jsonb not null default '{}'::jsonb
);
create index audit_logs_created_idx on public.audit_logs (created_at desc);
create index audit_logs_action_idx on public.audit_logs (action, created_at desc);

-- =============================================================================
-- Append-only / immutability guards
-- These fire for EVERY database role (including the dashboard's SQL editor),
-- so history cannot be silently rewritten. See supabase/scripts/ for the one
-- deliberate exception (clearing test data before the event).
-- =============================================================================
create or replace function public.forbid_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception '% on % is not allowed: this table is append-only', tg_op, tg_table_name
    using errcode = '42501';
end $$;

-- audit log, sale lines and stock movements: never updated or deleted
create trigger audit_logs_no_update before update or delete on public.audit_logs
  for each row execute function public.forbid_change();
create trigger transaction_items_no_update before update or delete on public.transaction_items
  for each row execute function public.forbid_change();
create trigger stock_movements_no_update before update or delete on public.stock_movements
  for each row execute function public.forbid_change();
create trigger audit_logs_no_truncate before truncate on public.audit_logs
  for each statement execute function public.forbid_change();

-- transactions: only completed -> voided, and nothing else may change
create or replace function public.guard_transaction_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Transactions cannot be deleted' using errcode = '42501';
  end if;
  if old.status <> 'completed' or new.status <> 'voided' then
    raise exception 'Only a completed transaction can change, and only to voided' using errcode = '42501';
  end if;
  if (new.id, new.txn_no, new.idempotency_key, new.section_code, new.cashier_id, new.created_at,
      new.business_date, new.item_count, new.total, new.total_cost, new.payment_method,
      new.amount_received, new.change_given)
     is distinct from
     (old.id, old.txn_no, old.idempotency_key, old.section_code, old.cashier_id, old.created_at,
      old.business_date, old.item_count, old.total, old.total_cost, old.payment_method,
      old.amount_received, old.change_given) then
    raise exception 'Transaction sale details are immutable' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger transactions_guard before update or delete on public.transactions
  for each row execute function public.guard_transaction_update();

-- void requests: only pending -> approved/rejected
create or replace function public.guard_void_request_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Void requests cannot be deleted' using errcode = '42501';
  end if;
  if old.status <> 'pending' or new.status = 'pending' then
    raise exception 'Void request already decided' using errcode = '42501';
  end if;
  if (new.id, new.transaction_id, new.section_code, new.requested_by, new.reason, new.requested_at)
     is distinct from
     (old.id, old.transaction_id, old.section_code, old.requested_by, old.reason, old.requested_at) then
    raise exception 'Void request details are immutable' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger void_requests_guard before update or delete on public.void_requests
  for each row execute function public.guard_void_request_update();

-- cash handovers: only "mark superseded" is allowed
create or replace function public.guard_cash_handover_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Cash handovers cannot be deleted' using errcode = '42501';
  end if;
  if old.superseded_at is not null or new.superseded_at is null then
    raise exception 'A cash handover can only be superseded once' using errcode = '42501';
  end if;
  if (new.id, new.business_date, new.section_code, new.cashier_id, new.cash_sales, new.cash_refunds,
      new.telda_sales, new.instapay_sales, new.transaction_count, new.expected_cash, new.actual_cash,
      new.difference, new.notes, new.recorded_by, new.recorded_at)
     is distinct from
     (old.id, old.business_date, old.section_code, old.cashier_id, old.cash_sales, old.cash_refunds,
      old.telda_sales, old.instapay_sales, old.transaction_count, old.expected_cash, old.actual_cash,
      old.difference, old.notes, old.recorded_by, old.recorded_at) then
    raise exception 'Cash handover figures are immutable' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger cash_handovers_guard before update or delete on public.cash_handovers
  for each row execute function public.guard_cash_handover_update();
