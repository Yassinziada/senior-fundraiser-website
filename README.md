# School Bazaar POS

> Staff-role update: see [STAFF_ROLES.md](STAFF_ROLES.md) for the five-role permission matrix, supplier workflow, and migration instructions.

An online point-of-sale system for a school event with two independent sales
sections, **Bazaar** and **Snacks**. It runs in the browser on laptops, tablets
and phones at the same time, and every device uses one central cloud database.

It started from the original single-file "Bazaar POS" (kept for reference in
[`legacy/Bazaar-POS-original.html`](legacy/Bazaar-POS-original.html)). The
workflow and look are carried over: the product cards, cart, payment window,
void requests, dashboard and reports. Everything else was rebuilt as a secure,
multi-user online application.

---

## Contents

1. [What this project is](#1-what-this-project-is)
2. [Features](#2-features)
3. [Architecture](#3-architecture)
4. [Requirements](#4-requirements)
5. [Setup, step by step](#5-setup-step-by-step)
6. [Running locally](#6-running-locally)
7. [Deploying to Vercel](#7-deploying-to-vercel)
8. [Using the system at the event](#8-using-the-system-at-the-event)
9. [Authentication design](#9-authentication-design)
10. [Security architecture](#10-security-architecture)
11. [User permissions](#11-user-permissions)
12. [Money, stock and report rules](#12-money-stock-and-report-rules)
13. [Duplicate-sale protection and network failures](#13-duplicate-sale-protection-and-network-failures)
14. [Database structure](#14-database-structure)
15. [Backup and exports](#15-backup-and-exports)
16. [Updating and redeploying](#16-updating-and-redeploying)
17. [Troubleshooting](#17-troubleshooting)
18. [Testing](#18-testing)
19. [Known limitations](#19-known-limitations)
20. [Project structure](#20-project-structure)

---

## 1. What this project is

* **Admin** manages products, prices, costs, stock, users and settings. The Admin
  approves voids, counts the cash boxes at the end of the day, and sees every
  report.
* **Cashiers** (Bazaar or Snacks) only sell. After signing in they go straight
  to the POS for their own section. They see product names, pictures, selling
  prices and stock, and nothing else.
* A sale made on any device is saved in the central database immediately, and
  the Admin dashboard updates live.

## 2. Features

**Cashier POS**
- Large touch-friendly product cards with the photo (or the original POS
  drawings), name, price and stock left, plus low-stock and out-of-stock badges
- Category filters, search, and a cart with + / − / remove / clear
- Payment by **Cash** (amount received → change, with quick-amount buttons),
  **Telda** or **InstaPay**
- A sale is shown as completed only after the database has saved it
- A clean receipt with **Print / Save PDF** (only the receipt is printed)
- "My sales today", reprinting receipts, and **Request void** with a mandatory
  reason
- A clear "Internet connection required to complete sale" message, safe retry,
  and no duplicate sales

**Admin**
- **Dashboard**: ALL / BAZAAR / SNACKS filter and date range. Shows revenue per
  section, Cash / Telda / InstaPay, transactions, units, average sale, estimated
  COGS and gross profit, voids, pending voids, cash differences, stock value,
  low and out-of-stock items, and charts. Updates live.
- **Sell**: the Admin can also sell in either section
- **Sales history**: search by transaction ID, dates, section, cashier, payment
  method and status. Shows the detail with the historical cost and profit, the
  receipt, printing, direct void, and CSV export.
- **Voids**: approve or reject pending requests. Approval restores stock
  exactly once, and full history is kept.
- **Products**: filter by section, category, active, low stock and out of stock.
  Shows price, cost, profit per item, margin, starting stock, sold, stock and
  minimum. From here the Admin can add or edit products, upload photos,
  activate or deactivate, and adjust stock (a reason is required).
- **Categories** per section
- **Stock log**: every stock change (starting stock, sale, void restore,
  add/remove with reason), with CSV export
- **Cash handover**: expected physical cash per cashier and section, actual
  count, difference, and totals per section and combined
- **Reports** with CSV export: daily, date range, by section, by payment method,
  by product, by category, by cashier, inventory, low stock, COGS and profit,
  voids and refunds, and cash reconciliation
- **Users**: create cashiers (username + PIN) or admins, assign a section,
  activate or deactivate, reset a PIN or password
- **Audit log**: permanent and filterable, with CSV export
- **Import**: products from the original POS backup file (.json) or a CSV file
- **Settings**: event name, currency, number format, timezone, default minimum
  stock, receipt header/footer, and whether to show the cashier on receipts

## 3. Architecture

```
 Browser (laptop / tablet / phone)
   │  React app (Vite build, static files on Vercel)
   │  holds ONLY the public anon/publishable key + the user's login session
   ▼
 Supabase (cloud)
   ├─ Auth ............ logins (passwords/PINs stored as bcrypt hashes)
   ├─ Data API ........ REST calls from the browser, always as the signed-in user
   ├─ Realtime ........ pushes changes (sales, stock, voids) to open screens
   ├─ Storage ......... product photos (public read, admin-only upload)
   ├─ Edge Function ... "admin-users": create users / reset PINs (server-side)
   └─ PostgreSQL ...... the single source of truth
        • Row Level Security on every table
        • all writes through secure database functions (checkout, voids, …)
        • constraints + append-only ledger tables
```

No server of your own has to run anywhere. Vercel hosts the static website and
Supabase hosts everything else.

**Why this stack.** React + Vite + Supabase is what you asked for. Supabase gives
you PostgreSQL (real transactions, row locks, exact `numeric` money), Row Level
Security, Auth, Realtime and Storage in one free-tier-friendly service, so the
security rules live next to the data and not in browser code.

## 4. Requirements

| What | Why | Where |
|---|---|---|
| **Node.js 20 or newer** (includes `npm`) | to run and build the app | https://nodejs.org → "LTS" |
| **Supabase account** (free plan is fine) | database, logins, storage | https://supabase.com |
| **Vercel account** (free "Hobby" plan is fine) | hosts the website | https://vercel.com |
| **GitHub account** | Vercel deploys from your repository | https://github.com |
| A modern browser | Chrome, Edge, Safari or Firefox (recent versions) | — |

Optional: the **Supabase CLI** (`npx supabase …`) if you prefer the command line
to the dashboard. Docker is only needed for the optional local test stack.

To check Node is installed, open a terminal and run `node -v`. It should print
`v20…` or higher.

## 5. Setup, step by step

Budget about 30–45 minutes the first time. Do the steps in this order.

### Step 1 — Create the Supabase project

1. Sign in at https://supabase.com and click **New project**.
2. Choose a name (e.g. `school-bazaar-pos`), a **strong database password**
   (save it in a password manager), and a region close to Egypt (e.g.
   *Frankfurt (eu-central-1)*).
3. Wait until the project says it is ready (1–2 minutes).

### Step 2 — Create the database (tables, security, functions)

1. In the Supabase dashboard open **SQL Editor** → **New query**.
2. Open the file [`supabase/ALL_IN_ONE_setup.sql`](supabase/ALL_IN_ONE_setup.sql)
   from this project in a text editor, **select all**, **copy**, and **paste** it
   into the SQL editor.
3. Click **Run**. You should see "Success. No rows returned".
   - Run it **once**, on a **new** project. Running it a second time fails
     with "already exists" errors. That is harmless, but it means it already
     ran.
   - This file is simply the four files in `supabase/migrations/` plus
     `supabase/seed.sql` joined together. CLI users can instead run
     `npx supabase link` and then `npx supabase db push`.

This creates the tables, the Row Level Security policies, the secure
functions, the `product-images` storage bucket, the realtime setup, the two
sections (Bazaar, Snacks) and the default settings.

### Step 3 — Add products (choose one)

* **A. The original Bazaar catalogue** (the 20 products and 2 face-painting
  services from the old POS, with their costs, suggested prices, starting stock
  20 and minimum stock 5). In SQL Editor → New query, paste
  [`supabase/data/bazaar_catalog_from_original_pos.sql`](supabase/data/bazaar_catalog_from_original_pos.sql)
  → **Run**.
* **B. Your own edited data from the old POS**: after Step 7, sign in as
  Admin → **Import** → choose the backup file downloaded from the old POS
  (Settings → *Download backup* there). This brings over your prices, costs,
  stock, categories, services and photos. Old sales are **never** imported.
* **C. A spreadsheet**: Admin → Import → *Download CSV template*, fill it in,
  import it.
* **Snacks**: add products in Admin → Products, or import a CSV. For testing
  only, you can load clearly labelled sample snacks with
  [`supabase/data/sample_snacks.sql`](supabase/data/sample_snacks.sql). Every
  name starts with `[SAMPLE]`. Remove them later with
  [`supabase/data/remove_sample_snacks.sql`](supabase/data/remove_sample_snacks.sql).

### Step 4 — Authentication settings (important)

In the Supabase dashboard, open **Authentication**:

1. **Sign In / Providers → Email**: keep **Email enabled**. Cashier PIN logins
   use it too.
2. **Sign In / Providers → "Allow new users to sign up"**: turn this **OFF**.
   Only the Admin creates accounts. (Even if it were left on, a self-registered
   user gets an *inactive* profile with no access. See §10.)
3. **Confirm email**: this can stay as it is. Accounts made by the Admin are
   created already confirmed.
4. **Password settings**: keep the **minimum password length at 6** (cashier
   PINs are 6–12 digits). Keep **"no required characters"**. A PIN is digits
   only.
5. **Rate limits**: keep Supabase's default sign-in rate limits. They protect
   the short PINs against guessing.

### Step 5 — Find your project URL and public key

Supabase dashboard → **Project Settings**:

* **Data API** (or **API**) → **Project URL**, e.g. `https://abcdefgh.supabase.co`
  → this is `VITE_SUPABASE_URL`.
* **API Keys** → the **publishable** key (`sb_publishable_…`), *or* on the
  "Legacy API keys" tab the **anon public** key (a long `eyJ…` text)
  → this is `VITE_SUPABASE_ANON_KEY`.

Never use the **service_role** key or a **secret** key (`sb_secret_…`) in
the app. The app refuses to start if you try.

### Step 6 — Create the first Admin

1. Supabase dashboard → **Authentication → Users → Add user → Create new user**.
2. Enter **your real email** and a **strong password (12+ characters)**, tick
   **Auto Confirm User**, then click **Create user**.
3. **SQL Editor → New query**, paste this with **your** email, then click **Run**:

   ```sql
   select public.make_admin('you@yourschool.org');
   ```

   It answers `OK: you@yourschool.org is now an active admin.`
   (The same text is in [`supabase/scripts/create_first_admin.sql`](supabase/scripts/create_first_admin.sql).)

`make_admin` can only be run from the SQL Editor. It is **not** callable from the
website or API. There is no built-in or default admin password anywhere.

### Step 7 — Deploy the `admin-users` Edge Function

Creating cashier logins and resetting PINs needs Supabase's secret key. That
key must stay on Supabase's servers, so this small function does it there.

**Option A — in the dashboard (no tools needed)**

1. Supabase dashboard → **Edge Functions** → **Deploy a new function** →
   **Via Editor**.
2. Name it exactly **`admin-users`**.
3. Delete the example code, then paste the entire content of
   [`supabase/functions/admin-users/index.ts`](supabase/functions/admin-users/index.ts).
4. Click **Deploy function**.
5. Open the function's **Details / Settings** and turn **"Enforce JWT
   verification" OFF**, then save. The function checks the caller's session
   and Admin status itself. Leaving this on can wrongly reject valid logins on
   projects that use the new API keys.

**Option B — command line**

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF   # the "abcdefgh" part of the URL
npx supabase functions deploy admin-users --no-verify-jwt
```

You do **not** need to add any secrets. `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are provided to the function automatically. (Only if
you have **disabled legacy API keys** in your project: add an Edge Function
secret named `POS_SERVICE_KEY` containing a `sb_secret_…` key.)

### Step 8 — Configure and run the app on your computer

```bash
# in the project folder
cp .env.example .env.local      # Windows (PowerShell): copy .env.example .env.local
```

Open `.env.local` in a text editor and fill in:

```
VITE_SUPABASE_URL=https://abcdefgh.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_...   (or the eyJ... anon key)
VITE_CASHIER_EMAIL_DOMAIN=cashiers.school-pos.app
```

Then run:

```bash
npm install
npm run dev
```

Open the address it prints (usually http://localhost:5173) and sign in with the
Admin **email + password** from Step 6.

### Step 9 — Create the cashiers

Admin → **Users** → **+ Create cashier**:

| Display name | Username | Section | PIN |
|---|---|---|---|
| Bazaar Cashier | `bazaar1` | Bazaar | 6–12 digits, e.g. `482913` |
| Snacks Cashier | `snacks1` | Snacks | a different 6–12 digit PIN |

Cashiers sign in with the **username** and **PIN** (the login screen shows a PIN
pad). You can add more cashiers at any time, move a cashier to the other section,
deactivate them, or reset their PIN.

> Internally a username becomes the login email `username@cashiers.school-pos.app`
> (`VITE_CASHIER_EMAIL_DOMAIN`). No email is ever sent to it.

### Step 10 — Put it online

See [§7 Deploying to Vercel](#7-deploying-to-vercel). Then run the
[testing checklist](#183-manual-pre-event-checklist) and, just before the event,
[clear the test sales](#83-before-the-event-clear-test-sales).

## 6. Running locally

| Command | What it does |
|---|---|
| `npm install` | downloads the libraries (first time, and after updates) |
| `npm run dev` | starts the app at http://localhost:5173 with live reload |
| `npm run build` | makes the production version in `dist/` |
| `npm run preview` | serves the production build locally to try it |
| `npm test` | runs the unit tests |
| `npm run test:db` | runs the database tests (needs a disposable PostgreSQL, see §18) |
| `npm run db:bundle` | regenerates `supabase/ALL_IN_ONE_setup.sql` after editing migrations |

To try it from a phone on the same Wi-Fi, run `npm run dev -- --host` and open
the "Network" address it prints.

## 7. Deploying to Vercel

1. Put this project in a **GitHub repository** (it already is one if you are
   reading this on GitHub).
2. Go to https://vercel.com → **Add New… → Project** → **Import** that repository.
3. Vercel detects **Vite** automatically. Leave these as they are:
   Build Command `npm run build`, Output Directory `dist`.
4. Open **Environment Variables** and add these three, each for **Production**,
   **Preview** and **Development**:

   | Name | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | your Project URL (Step 5) |
   | `VITE_SUPABASE_ANON_KEY` | your publishable / anon key (Step 5) |
   | `VITE_CASHIER_EMAIL_DOMAIN` | `cashiers.school-pos.app` (same as `.env.local`) |

5. Click **Deploy**. After about a minute you get an address like
   `https://school-bazaar-pos.vercel.app`. Open it on every device.
6. (Recommended) Supabase → **Authentication → URL Configuration → Site URL**:
   set it to your Vercel address.

`vercel.json` already routes every page to the app (so refreshing `/admin/sales`
works) and adds basic security headers.

**Environment variables later:** Vercel → your project → **Settings →
Environment Variables**. After changing one you must **redeploy** (Deployments →
⋯ → Redeploy). `VITE_…` values are baked into the website when it is built.

## 8. Using the system at the event

### 8.1 Cashier

1. Open the website → type the username → enter the PIN on the pad → **Sign in**.
2. Tap products to add them. Use + / − in the order panel. On phones, tap the
   green **View order** bar.
3. **Checkout** → choose **Cash / Telda / InstaPay**.
   * Cash: type (or tap) the amount received. The change is shown.
     **Complete Sale** stays disabled until the amount covers the total.
   * Telda / InstaPay: check the transfer has arrived, then **Complete Sale**.
4. Wait for **"Sale BZR-000123 saved"**. Only then hand over goods and change.
   Use **Print / Save PDF** if the customer wants a receipt (choose *Save as PDF*
   to send it on WhatsApp yourself).
5. Mistake? **My sales** → **Request void** → write the reason. The Admin decides.
6. Shared device? **Sign out** when leaving.

### 8.2 Admin

* Watch the **Dashboard**. The **Voids** badge shows waiting requests.
* **End of day → Cash handover**: pick the date. For each cashier, count the
  cash box, type the amount, and click **Record**. The difference is
  `actual − expected`. Recording again (a re-count) keeps the old record marked
  "corrected".
* **Reports** → export whatever you need as CSV.

### 8.3 Before the event: clear test sales

After you have tested everything, remove the practice sales so the real event
starts from zero:

1. (Optional) export anything you want to keep as CSV.
2. Supabase → SQL Editor → paste [`supabase/scripts/clear_test_data.sql`](supabase/scripts/clear_test_data.sql) → **Run**.

This deletes all transactions, voids and cash handovers, returns the sold stock
to the products, and restarts receipt numbers at 1. **Products, prices, costs,
users, settings and the full audit log are kept** (a `test_data_cleared` entry
is added). It is the only way ledger data can be removed, and it is not
available in the website.

## 9. Authentication design

* All logins go through **Supabase Auth**. Passwords and PINs are stored there
  as **bcrypt hashes**. The app's own tables never contain a password, PIN or
  hash.
* **Admins** sign in with email + password (10+ characters when created in the
  app).
* **Cashiers** sign in with **username + PIN** (6–12 digits). The app turns
  `bazaar1` into the internal login email `bazaar1@<VITE_CASHIER_EMAIL_DOMAIN>`,
  and the PIN is that account's password. Short PINs are protected by
  Supabase's sign-in **rate limiting**. Use 6+ random digits, not `123456`.
* Accounts are created **only by an Admin**, through the `admin-users` Edge
  Function. It runs on Supabase's servers, checks that the caller is an
  **active admin**, creates the login, and stores the role and section in the
  account's `app_metadata`, which users cannot edit themselves. A database
  trigger turns that into the user's `profiles` row.
* Accounts created any other way (dashboard, public sign-up) get an
  **inactive** profile and can do nothing until an Admin activates them in
  **Users** and gives them a role and section.
* **Deactivating** a user takes effect immediately in the database. Every
  policy and function checks `active`, so an already-open session is refused
  on its very next request.
* The first Admin is created with `make_admin(email)` in the SQL Editor
  (Step 6). That function cannot be reached from the internet.

## 10. Security architecture

The public key in the browser is **not a secret**. Anyone can read it from the
website. Security therefore does **not** depend on hiding it or on hiding
buttons. It depends on the database checking **who is asking**, on every
request.

1. **Row Level Security (RLS)** is on for every table.
   * Cashiers can read only: the sections list, the settings, **their own**
     profile, and **active products and categories of their own section**.
   * Every other table is **admin-only**: product costs, transactions, sale
     lines, voids, stock movements, cash handovers and the audit log. A cashier
     querying them directly gets **zero rows**. Asking for the other section's
     products also returns nothing.
2. **Cost is physically separated.** Product cost lives in `product_costs`
   (admin-only). The `products` table that cashiers can read **has no cost
   column**, so no query a cashier writes can return a cost. Sale lines with
   their cost snapshots are admin-only too. A cashier's own sales history comes
   from `pos_my_transactions()`, which returns no cost or profit fields.
3. **No direct writes.** The browser roles have **no INSERT / UPDATE / DELETE
   privilege on any table**. Every change goes through a `SECURITY DEFINER`
   database function: `pos_checkout`, `pos_request_void`, `admin_decide_void`,
   `admin_save_product`, `admin_adjust_stock`, … Each one checks the caller's
   role, `active` flag and section itself, and writes the audit log in the same
   transaction. `admin_*` functions refuse non-admins, and a cashier can only
   sell in their own section.
4. **Function allow-list.** Postgres lets everyone run functions by default.
   The migration revokes that for all functions, then grants only the intended
   ones. Internal helpers and `make_admin` are unreachable from the API.
5. **Tamper-proof history.** Triggers make the audit log, sale lines and stock
   movements **append-only**, even for the database owner. Transactions can
   only change from *completed* to *voided*. A unique index makes a second
   stock restore for the same sale impossible.
6. **Storage.** Product photos are publicly viewable (customers see them
   anyway). Only an active Admin can upload, replace or delete them.
7. **Realtime** follows the same RLS rules. Cashiers only receive their own
   section's product changes.

**These protections were tested against a real local Supabase stack by calling
the HTTP API directly with a cashier's token** (see §18). Examples: selecting
the cost column fails, admin tables return `[]`, a price update is denied,
admin functions return FORBIDDEN, and image uploads are refused.

### What you must NEVER expose

* The **service_role** key or any **secret** key (`sb_secret_…`). Never put it in
  `.env.local`, Vercel, GitHub, chat messages or screenshots. If it leaks,
  rotate it at once (Project Settings → API Keys).
* Your **database password**.
* Admin passwords and cashier PINs. Don't write PINs on the tablets.
* `.env.local` is already git-ignored. Keep it that way.

## 11. User permissions

| Can… | Admin | Cashier |
|---|:--:|:--:|
| Sell (own section) | ✓ (either section, via **Sell**) | ✓ |
| See product name / photo / price / stock | ✓ | own section only |
| See product cost, profit, margin, COGS | ✓ | ✗ |
| Edit prices, costs, stock, products, categories | ✓ | ✗ |
| See all sales / reports / dashboard | ✓ | ✗ (only own sales today, no cost) |
| Request a void | ✓ | own sales only |
| Approve / reject voids | ✓ | ✗ |
| Cash handover | ✓ | ✗ |
| Users, settings, audit log, import | ✓ | ✗ |

A cashier who types `/admin/...` in the address bar is sent back to the POS. If
they bypassed that in the browser, the database would still return nothing.

## 12. Money, stock and report rules

* Money is stored as PostgreSQL `numeric(12,2)` (exact decimals). Totals are
  computed **in the database**. The browser only works in integer cents for
  previews.
* Every sale line stores the **selling price and unit cost at the time of
  sale**. Revenue, COGS and profit always use those snapshots, so changing a
  product's price or cost later **never changes past figures**. Inventory value
  uses the *current* cost, because it describes today's stock.
* If a price changes while a cashier's cart is open, the sale is refused with
  "prices changed" instead of charging a different amount. The cart then
  updates to the new price.
* **Revenue** counts completed sales only. Voided sales appear under
  *Voids / refunds*.
* **Stock** decreases only when a sale is saved. Adding, removing or setting a
  counted quantity always requires a reason and creates a stock-log entry.
  Stock can never go below 0. Services (e.g. face painting) have
  **Track stock** off and never run out.
* **Low stock** means stock is at or below the product's minimum. **Out of
  stock** means 0.
* **Expected physical cash** for a cashier and section on a day:

  ```
  Expected = CASH sales made that day
           − CASH sales whose void was approved that day
  Difference = Actual counted − Expected
  ```

  Telda and InstaPay are shown next to it but are **never** part of the cash
  box.
* Dates are **business dates in the event timezone** (Settings, default
  `Africa/Cairo`).
* The currency is a setting (default **EGP**). All amounts are formatted from
  it, so nothing is hard-coded.

## 13. Duplicate-sale protection and network failures

* When the cashier presses **Complete Sale**, the app creates a random
  **checkout key** and saves it on the device **before** sending. The database
  has a **unique index** on that key and **locks** on it. If the same key
  arrives twice (a double-click, a slow network, a refresh, the Retry button),
  the second request gets the **already-saved sale** back instead of creating a
  new one. The button is also disabled while saving, and a same-instant second
  click is ignored.
* **Overselling is impossible.** The checkout locks the product rows. Two
  cashiers buying the last item at the same moment: one succeeds and the other
  is told "out of stock". Everything in a sale is one database transaction:
  all saved, or nothing.
* If the connection drops **during** a sale, the app does **not** claim success.
  It shows **"Sale not confirmed"** with **Retry safely** (same key, so it can
  never double-charge) and **Check status** (asks the database whether the sale
  exists). The cart is frozen until that is resolved, even across a page
  refresh.
* With no internet at all, the screen shows **"Internet connection required to
  complete sale."** and Complete Sale is disabled. There is no offline mode in
  V1 by design.

## 14. Database structure

| Table | What it holds |
|---|---|
| `sections` | BAZAAR, SNACKS (code, name, receipt prefix BZR/SNK) |
| `profiles` | one row per login: username, name, role (admin/cashier), section, active |
| `categories` | per-section categories |
| `products` | name, section, category, selling price, photo, stock tracking, starting/current/minimum stock, active, dates. **No cost.** |
| `product_costs` | estimated unit cost per product (**admin-only**) |
| `transactions` | one per sale: unique `txn_no` (e.g. `BZR-000123`), unique checkout key, section, cashier, time, business date, total, total cost, payment method, cash received/change, status, void info |
| `transaction_items` | sale lines with product name, **unit price & unit cost at the time of sale**, quantity, line totals |
| `stock_movements` | every stock change with before/after, reason, linked sale/void |
| `void_requests` | reason, who requested, status (pending/approved/rejected), who decided, when, note |
| `cash_handovers` | end-of-day counts: cash/Telda/InstaPay, expected, actual, difference (corrections supersede, never delete) |
| `audit_logs` | permanent log: time, user, action, section, entity, details |
| `app_settings` | event name, currency, locale, timezone, low-stock default, receipt texts |

The SQL lives in [`supabase/migrations/`](supabase/migrations/). The comments
there explain every rule.

## 15. Backup and exports

* **The database is the source of truth.** Nothing important is stored in the
  browser. Only the unfinished cart and the pending checkout key are kept on the
  device, for convenience.
* **Supabase backups**: paid plans include automatic daily backups (Project →
  Database → Backups). The **free plan has no downloadable automatic backups**,
  so make your own:
  1. **CSV exports** (easiest): Sales, Products, Reports (each tab), Stock log,
     Cash handover, Voids and Audit log all have **Export CSV**. Do this at the
     end of every event day.
  2. **Table export**: Supabase → Table Editor → pick a table → **Export → CSV**.
  3. **Full database dump** (technical): Project Settings → Database →
     connection string, then
     `pg_dump "postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres" -n public -Fc -f pos-backup.dump`
     (or `npx supabase db dump -f pos-backup.sql --data-only` with the CLI linked).
* The old POS's JSON backup is used only to **import products** (Admin → Import).

## 16. Updating and redeploying

* **Website changes**: commit and push to GitHub. Vercel redeploys automatically.
  Or click **Redeploy** in Vercel.
* **Environment variable changes**: change them in Vercel, then **Redeploy**.
* **Database changes**: add a **new** file in `supabase/migrations/`, never edit
  one that already ran. Run it in the SQL Editor (or `npx supabase db push`).
  Then run `npm run db:bundle` so the all-in-one file stays current for new
  installs.
* **Edge Function changes**: paste the new code in the dashboard editor and
  deploy, or run `npx supabase functions deploy admin-users --no-verify-jwt`.

## 17. Troubleshooting

| Problem | Likely cause → fix |
|---|---|
| **Blank page / "Setup needed"** | `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` missing. Locally: create `.env.local` and restart `npm run dev`. On Vercel: add them (§7) and **Redeploy**. Also check the browser console (F12). |
| **"Cannot connect" / "No connection to the server"** | Check the internet connection. Check the URL is exactly `https://<ref>.supabase.co` (no trailing path). Free Supabase projects **pause after a week of no use**: open the dashboard and click **Restore**. |
| **Wrong / swapped environment variables** | The URL goes in `VITE_SUPABASE_URL`, the publishable/anon key in `VITE_SUPABASE_ANON_KEY`. If the app says a *service role / secret* key was used, replace it and **rotate that secret key** in Supabase. |
| **"Wrong username or PIN/password"** | Check the username, not the display name. Cashiers use the PIN; admins use their email + password. If `VITE_CASHIER_EMAIL_DOMAIN` differs between where the cashier was created and where they log in, logins fail, so keep it identical everywhere. Reset the PIN in Admin → Users. |
| **"Email logins are disabled"** | Authentication → Providers → **Email must stay enabled** (only "Allow new users to sign up" should be off). |
| **"Account not active"** | Admin → Users → Edit → give the user a role (and a section for cashiers) → Active → Save. For the first admin: run `make_admin` (Step 6). |
| **Supabase rejects the cashier email domain** | Set `VITE_CASHIER_EMAIL_DOMAIN` to a domain you own (e.g. `pos.yourschool.org`), everywhere, and recreate the cashiers. |
| **"permission denied" / "Only an admin can do this" / RLS errors** | Expected for cashiers on admin data. For an admin: make sure your profile is active + admin (Users page or `make_admin`). If *everything* is denied, the migrations were not fully run; re-run Step 2 on a fresh project. |
| **Creating a cashier fails: "Could not reach the admin-users Edge Function"** | The function is not deployed or has a different name. Do Step 7 (name exactly `admin-users`). |
| **Creating a cashier fails with 401 / "Invalid JWT"** | Turn **Enforce JWT verification OFF** for `admin-users` (Step 7.5), or deploy with `--no-verify-jwt`. |
| **Works locally but not online** | Vercel variables missing, or added *after* the build → Redeploy. Refreshing a page gives 404 → make sure `vercel.json` is in the repo. |
| **Cashier sees no products** | Products must be **active**, in the cashier's **section**, and the cashier must be assigned to that section (Admin → Users). Check Admin → Products with the section filter. |
| **Realtime not updating** | Screens also refresh every 30 s and when the tab regains focus. Check that Step 2 ran completely (it adds the tables to realtime). Some school networks block websockets; the refresh still works. |
| **Receipt printing prints the whole page / nothing** | Use the **Print / Save PDF** button, not the browser menu, while the receipt is open. In the print dialog choose your printer or **Save as PDF**, and turn off "Headers and footers". On phones, use Share → Print. |
| **"Prices changed since the cart was filled"** | The Admin changed a price. The cart updated; check the new total with the customer and press Complete Sale again. |
| **"Sale not confirmed"** | The connection dropped mid-sale. Wait for the connection, then **Retry safely** (it cannot double-charge) or **Check status**. |
| **The SQL setup fails with "already exists"** | It already ran on this project. Don't run it twice. For a clean start, create a new Supabase project. |

## 18. Testing

### 18.1 Automated tests (all passing at delivery)

| Suite | Command | What it covers |
|---|---|---|
| **Unit** (22 tests) | `npm test` | cent-exact money maths and change, cart rules and stock limits, CSV escaping/formula-injection, event-timezone dates, login mapping, network-vs-business error detection, idempotency-key reuse, importing the original POS backup and CSV |
| **Database** (55 tests) | `TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm run test:db` | runs the **real migrations** on a disposable PostgreSQL with a Supabase-like `auth` schema, then acts as each user through RLS: section isolation, no cost access, no direct writes, admin-function refusal, anonymous access, checkout maths, snapshots, all payment methods, idempotency (sequential and 5 parallel), **last-item race**, 12 concurrent sales never oversell, void workflow and exactly-once restore (incl. concurrent approvals), cash handover formula, report totals, audit coverage, immutability, deactivation, the clear-test-data script |
| **Browser end-to-end** | see [`tests/e2e/README.md`](tests/e2e/README.md) | the real app in Chromium against a local Supabase stack (Docker): cashier and admin journeys, same-instant triple click → one sale, a response lost *after* the database saved → no false success and no duplicate on retry, offline, print-only receipt, live dashboard, Edge Function user creation, legacy import, phone layouts |

`npm run test:db` needs a **throw-away** PostgreSQL server (never your Supabase
project). It creates and deletes a database named `pos_test`. Without
`TEST_DATABASE_URL` those tests are skipped.

### 18.2 Requirement → where it is verified

| # | Check | Verified by |
|---|---|---|
| 1–3 | Admin / Bazaar / Snacks login | E2E admin & cashier; DB `accounts` |
| 4–5 | Each cashier sees only own-section products | DB `authorization`; E2E (all active Bazaar products only / Snacks only); HTTP check |
| 6–7 | No cost/profit, no other section data | DB (`select cost` fails, admin tables empty); HTTP check |
| 8 | Admin sees both sections | DB |
| 9–12 | Cash / Telda / InstaPay, correct change | DB `checkout`; unit `money`; E2E |
| 13 | Stock decreases once | DB; E2E |
| 14 | Last item can't sell twice | DB race tests |
| 15 | Double-click → one sale | DB (5 parallel); E2E (same-tick triple click) |
| 16–17 | Receipt + print | E2E (content + print media shows only receipt) |
| 18–22 | Void request, cashier can't approve, approval, restore once, no second restore | DB `void workflow`; E2E |
| 23 | Reports update | DB report totals = raw data; E2E live dashboard |
| 24 | Historical cost unchanged after edit | DB; E2E |
| 25–26 | Expected cash excludes Telda/InstaPay; difference | DB `reports & end-of-day cash`; E2E |
| 27 | CSV exports | unit `csv`; E2E downloads sales CSV |
| 28 | Audit log | DB (15 actions); E2E |
| 29 | Cashier can't open admin URLs | E2E redirect |
| 30 | API protection without the frontend | DB (runs as `authenticated` via SQL); HTTP check with `curl` against Supabase's REST API |

### 18.3 Manual pre-event checklist

Do this on the **real** deployed site, with the real devices, the day before:

- [ ] Admin signs in on laptop **and** phone
- [ ] Bazaar cashier signs in on its tablet: only Bazaar products, no cost anywhere
- [ ] Snacks cashier signs in: only Snacks products
- [ ] Cashier types `…/admin` in the address bar → sent back to the POS
- [ ] Cash sale: e.g. total 210, received 250 → change 40 shown and on the receipt
- [ ] Received less than the total → Complete Sale stays disabled
- [ ] Telda sale and InstaPay sale complete (no change field)
- [ ] Receipt → **Print / Save PDF** → only the receipt is in the PDF
- [ ] Admin dashboard shows the sales within seconds, split by section and method
- [ ] Stock of the sold product went down by exactly the quantity sold
- [ ] Set a product's stock to 1 → it sells once, then shows OUT OF STOCK on both tablets
- [ ] Double-tap Complete Sale quickly → only one sale in Admin → Sales
- [ ] Turn Wi-Fi off on a tablet → "Internet connection required" and no sale possible; turn it on → works
- [ ] Cashier requests a void → Admin sees it on **Voids** → Approve → stock returns once; the sale shows VOIDED
- [ ] Reject another request → the sale stays valid, with the rejection recorded
- [ ] Change a product's cost → the old sale's cost in Sales → detail is unchanged
- [ ] Cash handover: expected equals the cash sales only (not Telda/InstaPay); enter the count → difference is correct
- [ ] Export a CSV from Reports and open it in Excel/Sheets
- [ ] Audit log shows the logins, sales, void, cost change and handover
- [ ] Deactivate a test cashier → they can no longer sell
- [ ] Printer (if used) prints a receipt from each device
- [ ] Finally, run **clear_test_data.sql** (§8.3) and check Sales is empty

## 19. Known limitations

* **Internet is required** to sell (by design for V1). There is no offline queue.
* **Free Supabase projects pause** after about a week without use. Open the
  project in the dashboard a day before the event.
* Supabase's **free plan has no automatic downloadable backups**. Use the CSV
  exports (§15) or a paid plan.
* PIN logins are protected by Supabase's rate limiting, not by an account
  lock-out counter. Use random 6+ digit PINs and deactivate cashier accounts
  after the event.
* Receipts use the browser's print dialog (printer / Save as PDF). There is no
  direct thermal-printer driver or WhatsApp sending (as requested for V1).
* One currency at a time (a setting). Changing it relabels all amounts; it does
  not convert them.
* The **CSV / JSON product import** skips products whose name already exists in
  that section. It does not update existing products.

## 20. Project structure

```
.
├── README.md                  ← this guide
├── .env.example               ← the environment variable names (copy to .env.local)
├── package.json, vite.config.js, vercel.json, index.html
├── legacy/Bazaar-POS-original.html   ← the original single-file POS (reference/import source)
├── public/                    ← favicon
├── src/
│   ├── main.jsx, App.jsx      ← entry + routing/guards
│   ├── lib/supabase.js        ← the only Supabase client (public key only)
│   ├── context/               ← auth, settings (currency/timezone), toasts
│   ├── hooks/                 ← async loading, realtime, online status
│   ├── services/              ← all database calls (pos.js for cashiers, admin.js for admin)
│   ├── utils/                 ← money (cents), cart, CSV, dates, import parser, idempotency…
│   ├── components/            ← modal, receipt + print area, filters, charts, badges…
│   ├── pages/pos/             ← cashier POS, checkout, my sales
│   ├── pages/admin/           ← dashboard, sales, voids, products, stock, cash, reports, users, audit, import, settings
│   └── styles/                ← index.css (look of the original POS), print.css (receipt only)
├── supabase/
│   ├── migrations/            ← 001 schema · 002 security/RLS · 003 business functions · 004 storage/realtime
│   ├── seed.sql               ← sections + settings (required)
│   ├── ALL_IN_ONE_setup.sql   ← migrations + seed in one file for the SQL Editor
│   ├── data/                  ← optional: original Bazaar catalogue, sample snacks (+ removal)
│   ├── scripts/               ← create_first_admin.sql, clear_test_data.sql
│   ├── functions/admin-users/ ← Edge Function: create users, reset PINs
│   └── config.toml            ← Supabase CLI config (local development)
├── scripts/bundle-sql.mjs     ← builds ALL_IN_ONE_setup.sql
└── tests/
    ├── unit/                  ← npm test
    ├── db/                    ← npm run test:db (real migrations, RLS, races)
    └── e2e/                   ← optional browser tests + local setup script
```
Deployment trigger
