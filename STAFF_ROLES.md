# Staff roles and supplier lists

Adds Finance, Product Manager and Supplier alongside Admin and Cashier.
Uses the existing Supabase project; no paid service is introduced.

| Role | Access |
|---|---|
| Admin | Existing full access, accounts and supplier lists |
| Cashier | Existing section-specific selling and own sales |
| Finance | Dashboard, reports, costs and cash reconciliation; no product editing, checkout or void approval |
| Product Manager | Products, prices/costs, categories, stock, imports and supplier lists; no sales ledger, financial reports, accounts or settings |
| Supplier | Assigned lists and availability checkboxes only; no catalogue, costs, financial reports or stock editing |

Staff other than cashiers use email/password login. Cashier username/PIN login
is unchanged. Passwords for new staff accounts must contain 10–72 characters.
When promoting a cashier to a staff role, reset their password accordingly.

## Workflow

1. Admin creates an active Supplier account under Users.
2. Admin or Product Manager opens Supplier lists, chooses a supplier, and adds
   active, stock-tracked products and quantities.
3. Supplier signs in and ticks products they can supply. This confirms
   availability, not delivery or payment. It does not change stock.
4. After physical delivery, Admin or Product Manager enters the quantity and
   presses Confirm received. Partial deliveries are supported.
5. Receipt confirmation adds stock, creates a stock movement, and records an
   immutable receipt and audit entry in one database transaction.

Receipt retries reuse a persisted UUID and cannot add stock twice. Unresolved
create/receipt actions block new actions until retried. If browser storage is
unavailable, the action is not sent. Completed items cannot be checked again.

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
2. Apply only the three new migrations in order:
   `20261107000001_roles.sql`, `20261107000002_staff_permissions.sql`, and
   `20261107000003_supplier_orders.sql`. Commit the enum migration before using
   new role values. Existing applied migrations are unchanged.
3. **Do not run ALL_IN_ONE_setup.sql on the existing database.** The generated
   bundle is for new installations only.
4. Deploy the updated admin-users Edge Function with its existing server-side
   authorization and `--no-verify-jwt` configuration.
5. Deploy the reviewed frontend and create accounts in Users. Verify each role
   in staging before production rollout.

No resets, table deletions, or security-disabling steps are required. For a
rollback, deactivate new staff accounts and revert the frontend; retain new
tables and audit history. Do not delete enum values or supplier receipts.

## Validation

- Existing 22 unit tests and the Vite production build pass.
- All seven migrations apply on embedded PostgreSQL (PGlite).
- Eleven database scenario groups cover role provisioning, permission denial,
  existing sales, finance reports/reconciliation, list isolation, availability,
  partial receipts, retries, overreceipt rejection, immutable/audited receipts,
  and deactivation.
- `tests/db/staff-roles.test.js` runs those same checks on disposable PostgreSQL
  via TEST_DATABASE_URL, in a separate pos_roles_test database.
- `tests/e2e/staff-roles.e2e.mjs` verifies all five interfaces with mocked local
  Supabase endpoints. These are UI tests, not production integration tests.

The full multi-connection PostgreSQL suite and real Supabase Auth/Edge
integration still need staging validation. Embedded tests do not establish
concurrency behavior or production policy correctness.
