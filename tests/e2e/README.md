# Optional browser end-to-end tests

These drive the real app in Chromium against a **local** Supabase stack
(Docker). They are not needed to use the POS; they are for whoever maintains it.

What they check (all passed when this project was delivered):

* **Cashier** (`cashier.e2e.mjs`): PIN login, only own-section products, no cost shown,
  cash sale with change, receipt content, print shows only the receipt,
  stock decreases exactly once, Telda and InstaPay sales, three clicks in the same
  instant create one sale, a response lost AFTER the server saved the sale
  (no false "completed", and "Retry" doesn't duplicate), a page refresh during an
  unconfirmed sale, offline blocking, `/admin` URL redirect, own history without
  cost, void request, and the phone layout.
* **Admin** (`admin.e2e.mjs`): email login, dashboard totals = database, live update
  from another device, void approval restores stock once, sales filters + CSV,
  cost edit keeps the historical cost, stock adjustment needs a reason, photo upload,
  cashier creation through the Edge Function, cash handover difference, every
  report tab, importing an original-POS backup, currency setting, audit entries, and
  the phone layout.

## Run

```bash
npx supabase start                     # needs Docker
bash tests/e2e/setup-local.sh          # admin, catalogue, 2 cashiers
# .env.local -> VITE_SUPABASE_URL=http://127.0.0.1:54321 and the local ANON key
npm run dev                            # in another terminal
npm i --no-save playwright && npx playwright install chromium
node tests/e2e/cashier.e2e.mjs
node tests/e2e/admin.e2e.mjs
```

Screenshots are written to `tests/e2e/shots/` (git-ignored).
