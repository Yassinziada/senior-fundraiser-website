# Approved live launch: keep the old catalogue

The user authorized production rollout and a fresh event. The latest correction
keeps products from the old live database, not the preview database.

Target: `bpyqftcwmikfrqfpsemz` (the database referenced by the existing production
site at https://senior-fundraiser-website.vercel.app). Do not reset or promote the
preview/test database `vwddggtxsvtgfikkcyxh`.

Keep products, categories, prices, current unit costs, product image URLs and
Storage files, event settings/sections, and the active Admin account
`yassinziada@gmail.com`. Clear stock/starting-stock quantities, sales/voids,
handovers, supplier lists/receipts, money/opening balances, old audit records and
all other profiles/Auth users. The Admin password is unchanged. One new audit
record records the reset counts. Numeric IDs/sequences are not recycled.

## Order of operations

1. Stop use of the website and close all POS tabs on every device. Export any
   old reports you still want before the destructive reset.
2. Open https://supabase.com/dashboard/project/bpyqftcwmikfrqfpsemz/sql/new.
   Run `supabase/scripts/launch_01_roles.sql` by itself and wait for success.
3. In a separate query, run
   `supabase/scripts/launch_02_upgrade_reset_keep_catalogue.sql`.
   This upgrades only missing staff/supplier/money migrations and clears the
   approved data in one transaction. It requires the active Admin above and
   refuses a second reset. Any failure rolls back all changes made by the reset script.
   Check the final result: catalogue counts retained, one account, zero money
   entries. If it errors, stop and inspect the error; do not disable extra guards.
4. In the same live Supabase project, deploy the repository's current
   `supabase/functions/admin-users/index.ts` as `admin-users`. If it exists,
   replace its code and deploy the update. Set legacy JWT verification OFF;
   the function validates the caller's Auth JWT and active Admin role itself.
5. Merge reviewed PR #1 into the configured production branch
   `claude/school-bazaar-pos-od14xl`, then verify the Vercel production deployment.
   Production uses the existing live environment variables. Do not promote the
   preview deployment or copy the test project's variables into production.
6. Clear this website's local site data on previously used devices and sign in
   again to discard cached carts/pending test actions. Do not retry an old pending
   action after the reset. Open the normal production URL, not the feature preview.
7. Admin -> Money: enter actual Cash and Telda balances once. Then receive real
   stock. Already-owned stock paid before the opening balance is not a new cash
   purchase: record a counted-stock correction with a clear reason, retaining its
   existing cost basis. New paid stock uses Add stock and deducts its buying cost.
8. Admin -> Users: create new accounts for Finance, Product Manager, Supplier and
   the required Bazaar/Snacks cashiers. Usernames/emails and passwords/PINs are
   entered by the Admin; never commit or paste credentials into chat.
9. Check the production catalogue, fresh balances and one login per role before
   opening to sellers. Use genuine transactions only once money tracking begins.

## Validation and limits

The reset is tested on local PostgreSQL with the original live-schema version,
seeded catalogue, Admin/cashier and a sale. Checks cover catalogue/cost/image
preservation, Admin preservation, empty event ledgers and zero stock, re-enabled
immutable triggers, missing-Admin refusal, repeated-reset refusal, and complete
rollback when a foreign key prevents Auth user deletion.

Real Supabase managed Auth/Storage constraints may differ from the local harness.
The script deliberately lets such constraints fail and roll back; it never uses
CASCADE or disables foreign keys. No live SQL or Edge Function deployment can be
performed through the currently connected tools, so those two steps are manual.
Publication is authorized, but must wait until the live database and Edge Function
are ready. The new-account details have not yet been supplied.
