# Staff roles and supplier lists

Adds Finance, Product Manager and Supplier alongside Admin and Cashier.
Uses the existing Supabase project; no paid service is introduced.

| Role | Access |
|---|---|
| Admin | Existing full access, accounts and supplier lists |
| Cashier | Existing section-specific selling and own sales |
| Finance | Dashboard, Money balances/expenses/transfers, reports, costs and cash reconciliation; no product editing, checkout or void approval |
| Product Manager | Products, prices/costs, categories, stock, imports and supplier lists; no sales ledger, financial reports, accounts or settings |
| Supplier | Assigned lists and purchased/delivered quantities only; no catalogue, costs, financial reports or stock editing |

Staff other than cashiers use email/password login. Cashier username/PIN login
is unchanged. Passwords for new staff accounts must contain 10–72 characters.
When promoting a cashier to a staff role, reset their password accordingly.

## Workflow

1. Admin creates an active Supplier account under Users.
2. Admin or Product Manager opens Supplier lists, chooses a supplier, and adds
   active, stock-tracked products and quantities.
3. Supplier enters the **total quantity bought** and presses Confirm purchased.
4. Supplier enters the **total quantity delivered** and presses Confirm delivered.
   A delivery cannot exceed the confirmed purchased quantity. Neither step adds stock.
5. Admin or Product Manager enters the additional quantity physically received.
   Receipt is blocked until the assigned supplier has confirmed both purchase and
   delivery. The receiver can add at most `delivered - received` units.
6. Receipt deducts quantity × actual buying price from the chosen account, adds stock, creates a stock movement, and records an immutable receipt
   and audit entry in one transaction. Partial purchases, deliveries and receipts
   are supported. Only the assigned supplier may confirm purchases and deliveries;
   Admin/Product Manager cannot make those confirmations on their behalf.

The invariant is `0 <= received <= delivered <= purchased <= requested`.
Supplier entries are cumulative totals including earlier batches, not increments.
Confirmed totals cannot decrease; increases and confirmations are audited. Repeating
an identical confirmation has no additional effect. Receipt retries reuse a persisted
UUID and cannot add stock twice. Unresolved actions block new actions until retried.
If browser storage is unavailable, the action is not sent. Manual stock adjustments
require a reason and payment details for purchases. Donations and count corrections do not spend money.

The old Can supply control and API access are removed. Its stored availability
values remain for history. The new migration copies historical received quantities
into the new totals without inventing supplier confirmations or changing stock.
Any new receipt against a historical list needs explicit supplier purchase and
delivery confirmations. Repeating an already saved old receipt remains safe.

Lists appear inside the authenticated app; this change sends no external
notifications and creates no anonymous links. Lists refresh every 30 seconds
and manually. Editing, cancellation and reassignment are outside this change.

## Deployment to an existing project (approval required)

Prepared on the separate test branch; not applied to the live fundraiser.
The test database was initialized separately through the Supabase SQL Editor.

The Vercel Preview build of `feature/staff-roles-supplier-orders` is pinned to
Fundraiser Test through `config/staff-preview.json`. This contains only public
client configuration, not a service-role key or password. `npm run build:staging`
uses the same configuration locally. Other branches and production builds keep
using their normal Vite environment variables. Do not promote the test preview
to production; deploy the reviewed production branch with its live environment.

1. Verify the Vercel production branch and a database backup.
2. Apply only the five new migrations in order:
   `20261107000001_roles.sql`, `20261107000002_staff_permissions.sql`,
   `20261107000003_supplier_orders.sql`, `20261107000004_supplier_fulfillment.sql`, then
   `20261107000005_money.sql`. Commit the enum migration before using
   new role values. Existing applied migrations are unchanged.
   For the existing test project with roles/lists already installed, use
   `supabase/scripts/upgrade_supplier_money.sql`. It applies only the missing
   supplier confirmation and money migrations and is safe to rerun. It preserves data.

3. **Do not run ALL_IN_ONE_setup.sql on the existing database.** The generated
   bundle is for new installations only.
4. Deploy the updated admin-users Edge Function with its existing server-side
   authorization and `--no-verify-jwt` configuration.
5. Deploy the reviewed frontend and create accounts in Users. Verify each role
   in staging before production rollout.

No resets, table deletions, or security-disabling steps are required. For a
rollback, deactivate new staff accounts and revert the frontend; retain new
tables and audit history. Do not delete enum values or supplier receipts.

## Money tracking

Admin opens Money and records the current Cash, Telda and InstaPay balances once.
This marks the start of tracking; earlier sales/purchases are not backfilled or
counted twice. Existing inventory retains its existing cost basis. Enter balances
before buying more stock. Zero opening balances are allowed.

- Available money = opening balances + net sales collected − paid stock purchases
  − operating expenses − refunds of sales predating the opening.
- Total available money always equals Cash + Telda + InstaPay.
- Gross profit = tracked sales after refunds − sale-time cost of the sold units.
- Net profit = gross profit − operating expenses − recorded stock losses.
- Purchase confirmations alone do not spend money. Manager receipt approval is a
  **paid receipt**: enter actual unit buying price and payment account. Payment,
  stock and receipt history commit together or all roll back. Partial receipts
  deduct only that batch. Unpaid supplier credit is not supported in this version.
- Manual paid additions, initial stock on new products and imported stock follow
  the same rule. Stock additions need opening balances first. Imported products
  already present are skipped, without payment. Check the import preview costs.
- No-money additions are free/donated inventory with zero buying cost. Counted-stock
  corrections keep current unit cost; decreases are recognized as noncash stock
  losses. These are not purchase or refund operations.
- Purchase receipts update the moving weighted-average unit cost, rounded to two
  decimals. Past sales retain their snapshots. Refunds restore sale-time cost to
  the inventory average. Editing the cost of owned stock is blocked after opening.
  Legacy inventory costs must be accurate before enabling tracking; service costs
  remain configured estimates. These are management figures, not a statutory ledger.
- Admin/Finance record paid operating expenses and transfers. Transfers have equal
  outgoing/incoming entries and do not change total money or profit. Cash handovers
  are custody changes within the Cash balance and do not add income.
- Approved voids mean full refund through the original payment account. They reduce
  that balance and reverse sale/COGS once. Refunds can make an account negative;
  the Money page flags it. Other outgoing payments cannot exceed the account balance.
- Ledger and opening entries cannot be edited/deleted. No restart/reset or backdating
  UI is included. Correcting an expense or opening balance requires a separately
  reviewed adjustment workflow; never enter stock purchases again as expenses.
- Action payloads and UUIDs persist before sending. After an uncertain network result,
  retry the stored action; never create a second purchase to compensate for a timeout.
  One device/user should finish outstanding actions before switching devices.
- Existing pre-opening stock APIs are rejected once money starts, closing older-client
  payment bypasses. Internal unfunded helpers are not executable by API roles.

The Money page reports all sections since opening. Existing Dashboard/Reports keep
selected date/section sales reporting. No bank/provider API is connected: balances
reflect recorded payments and should be reconciled with actual accounts.

## Validation

- Unit tests and production/staging builds.
- All nine migrations apply on embedded PostgreSQL and PostgreSQL 16.
- Full PostgreSQL suite includes original checkout/void races, new staff permissions,
  supplier upgrades, money accounting, immutable history, and real concurrent
  spending/receipt/refund tests. Test databases are disposable and local only.
- Chromium smoke checks cover all five roles, category changes, supplier receipts,
  opening balances, expenses, transfers and retry recovery across refresh using
  mocked local Supabase endpoints.
- Authenticated end-to-end use of the real test Supabase project remains a manual
  staging check. No production migrations or merge have been performed.

## Current payment options

New checkout, stock payment, opening balance, expense and transfer forms offer
Cash and Telda only. The InstaPay enum and stored history remain compatible with
older records; nonzero historical amounts still appear in reports and totals.
This is a frontend option change, with no database migration. Older clients/API
remain backward compatible. Refresh devices to use the current payment choices.
