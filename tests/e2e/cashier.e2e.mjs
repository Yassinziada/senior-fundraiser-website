// Optional browser end-to-end test (see tests/e2e/README.md).
// Runs against a LOCAL Supabase stack prepared by tests/e2e/setup-local.sh.
// Browser E2E: cashier flows against the local Supabase stack.
import { chromium } from 'playwright';
import pg from 'pg';

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
import { mkdirSync } from 'node:fs';
const OUT = new URL('./shots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const db = new pg.Client({ connectionString: process.env.E2E_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' });
await db.connect();
const q = async (sql, p) => (await db.query(sql, p)).rows;
const log = (...a) => console.log('•', ...a);
const assert = (c, m) => {
  if (!c) throw new Error('ASSERT: ' + m);
  log('ok -', m);
};

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
page.on('console', (m) => m.type() === 'error' && console.log('console.error', m.text()));

async function login(p, id, secret) {
  await p.goto(BASE + '/login');
  await p.getByPlaceholder('e.g. bazaar1').fill(id);
  await p.locator('input[type=password]').fill(secret);
  await p.getByRole('button', { name: 'Sign in' }).click();
}

// 1. login as Bazaar cashier
await login(page, 'bazaar1', '482913');
await page.waitForURL('**/pos');
await page.getByText('Keychains').first().waitFor();
const names = await page.locator('.pcard .pname').allTextContents();
const expectedN = (await q(`select count(*)::int n from products where section_code='BAZAAR' and active`))[0].n;
assert(names.length === expectedN, `bazaar cashier sees all ${expectedN} active Bazaar products (got ${names.length})`);
assert(!names.some((n) => n.includes('[SAMPLE]')), 'no Snacks products visible');
const html = await page.content();
assert(!/\bcost\b/i.test(await page.locator('.pos').innerText()), 'no "cost" text on POS screen');
await page.screenshot({ path: OUT + '01-pos.png' });

// 2. cash sale: 2x Keychains (40) + 1x Caps (130) = 210, received 250 -> change 40
const card = (n) => page.locator('.pcard', { has: page.locator('.pname', { hasText: new RegExp(`^${n}$`) }) });
await card('Keychains').click();
await card('Keychains').click();
await card('Caps').click();
assert((await page.locator('.t-total').innerText()).includes('210'), 'cart total 210');
const stockBefore = (await q(`select stock from products where name='Keychains'`))[0].stock;
await page.getByRole('button', { name: /CHECKOUT/ }).click();
await page.locator('#received').fill('200');
assert((await page.locator('.t-change').innerText()).includes('Short by'), 'short payment flagged');
assert(await page.getByRole('button', { name: 'COMPLETE SALE' }).isDisabled(), 'complete disabled when short');
await page.locator('#received').fill('250');
assert((await page.locator('.t-change').innerText()).includes('40'), 'change preview 40');
await page.screenshot({ path: OUT + '02-payment.png' });
await page.getByRole('button', { name: 'COMPLETE SALE' }).click();
await page.getByText(/Sale BZR-\d+ saved/).waitFor();
assert((await page.locator('.big-change').innerText()).includes('40'), 'receipt shows change 40');
const rtext = await page.locator('.receipt-screen .receipt').innerText();
assert(/Keychains/.test(rtext) && /210/.test(rtext) && /250/.test(rtext) && /Cash/.test(rtext), 'receipt lists items, total, received, method');
await page.screenshot({ path: OUT + '03-receipt.png' });
await page.emulateMedia({ media: 'print' });
await page.screenshot({ path: OUT + '04-print-preview.png' });
const printVisible = await page.evaluate(() => ({
  root: getComputedStyle(document.getElementById('root')).display,
  area: getComputedStyle(document.querySelector('.print-area')).display,
  modal: getComputedStyle(document.querySelector('.modal-bg')).display,
}));
assert(printVisible.root === 'none' && printVisible.area === 'block' && printVisible.modal === 'none', 'print media shows only the receipt');
await page.emulateMedia({ media: 'screen' });
await page.getByRole('button', { name: 'Close' }).last().click();
const stockAfter = (await q(`select stock from products where name='Keychains'`))[0].stock;
assert(stockAfter === stockBefore - 2, `stock decreased by exactly 2 (${stockBefore} -> ${stockAfter})`);

// 3. Telda sale
await card('Gel pens').click();
await page.getByRole('button', { name: /CHECKOUT/ }).click();
await page.getByRole('radio', { name: 'Telda' }).click();
await page.getByRole('button', { name: 'COMPLETE SALE' }).click();
await page.getByText(/Sale BZR-\d+ saved/).waitFor();
assert(!(await page.locator('.big-change').count()), 'no change shown for Telda');
await page.getByRole('button', { name: 'Close' }).last().click();

// 4. Telda + double-click protection (Cash/Telda are the only new choices)
const before = (await q(`select count(*)::int n from transactions`))[0].n;
await card('Erasers').click();
await page.getByRole('button', { name: /CHECKOUT/ }).click();
assert((await page.getByRole('radio', { name: 'InstaPay' }).count()) === 0, 'InstaPay is not offered for new sales');
await page.getByRole('radio', { name: 'Telda' }).click();
// three clicks in the same JS tick, before React can disable the button
let rpcCalls = 0;
page.on('request', (r) => r.url().includes('/rpc/pos_checkout') && rpcCalls++);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'COMPLETE SALE');
  b.click();
  b.click();
  b.click();
});
await page.getByText(/Sale BZR-\d+ saved/).waitFor();
await page.getByRole('button', { name: 'Close' }).last().click();
const after = (await q(`select count(*)::int n from transactions`))[0].n;
assert(after === before + 1, `triple click created exactly one sale (${before} -> ${after}; ${rpcCalls} checkout request(s) sent)`);

// 5. Response lost after the server committed -> "not confirmed" -> safe retry
const before2 = (await q(`select count(*)::int n from transactions`))[0].n;
let dropped = false;
await page.route('**/rest/v1/rpc/pos_checkout', async (route) => {
  if (!dropped) {
    dropped = true;
    await route.fetch(); // the request reaches the database and commits...
    return route.abort('failed'); // ...but the browser never gets the answer
  }
  return route.continue();
});
await card('Scrunchies').click();
await page.getByRole('button', { name: /CHECKOUT/ }).click();
await page.locator('#received').fill('30');
await page.getByRole('button', { name: 'COMPLETE SALE' }).click();
await page.getByText('Sale not confirmed').waitFor();
assert(!(await page.getByText(/Sale BZR-\d+ saved/).count()), 'no false "Sale completed" after a lost response');
await page.screenshot({ path: OUT + '05-uncertain.png' });
// cart is frozen while unresolved
await page.getByRole('button', { name: 'RETRY SAFELY' }).click();
await page.getByText(/Sale BZR-\d+ saved/).waitFor();
assert((await page.getByRole('heading', { name: 'Sale already saved' }).count()) === 1, 'retry reports the already-saved sale');
await page.getByRole('button', { name: 'Close' }).last().click();
await page.unroute('**/rest/v1/rpc/pos_checkout');
const after2 = (await q(`select count(*)::int n from transactions`))[0].n;
assert(after2 === before2 + 1, `retry after lost response did not duplicate (${before2} -> ${after2})`);

// 6. Refresh with an unresolved attempt -> status check
dropped = false;
await page.route('**/rest/v1/rpc/pos_checkout', (route) => route.abort('failed')); // never reaches server
await card('Mini rulers').click();
await page.getByRole('button', { name: /CHECKOUT/ }).click();
await page.getByRole('radio', { name: 'Telda' }).click();
await page.getByRole('button', { name: 'COMPLETE SALE' }).click();
await page.getByText('Sale not confirmed').waitFor();
await page.unroute('**/rest/v1/rpc/pos_checkout');
await page.reload();
await page.getByText('Sale not confirmed').waitFor();
assert(true, 'after refresh the unconfirmed sale is still tracked');
await page.getByRole('button', { name: 'Check status' }).click();
await page.getByText(/was not recorded/).first().waitFor();
assert(true, 'status check says the sale was NOT recorded, cart kept');
await page.getByRole('button', { name: 'COMPLETE SALE' }).click();
await page.getByText(/Sale BZR-\d+ saved/).waitFor();
await page.getByRole('button', { name: 'Close' }).last().click();

// 7. Offline
await ctx.setOffline(true);
await page.evaluate(() => window.dispatchEvent(new Event('offline')));
await card('Keychains').click();
await page.getByText('Internet connection required to complete sale.').first().waitFor();
await page.getByRole('button', { name: /CHECKOUT/ }).click();
assert(await page.getByRole('button', { name: 'COMPLETE SALE' }).isDisabled(), 'cannot complete sale offline');
await page.screenshot({ path: OUT + '06-offline.png' });
await page.keyboard.press('Escape');
await ctx.setOffline(false);
await page.evaluate(() => window.dispatchEvent(new Event('online')));
await page.getByRole('button', { name: 'Clear' }).first().click();

// 8. cashier cannot open admin routes
await page.goto(BASE + '/admin/products');
await page.waitForURL('**/pos');
assert(true, '/admin/products redirects a cashier to /pos');

// 9. My sales + void request
await page.getByRole('link', { name: 'My sales' }).click();
await page.getByText('My sales today').waitFor();
const rows = await page.locator('tbody tr').count();
assert(rows >= 5, `my sales lists today's sales (${rows})`);
assert(!/cost|profit/i.test(await page.locator('.page').innerText()), 'no cost/profit in cashier history');
await page.getByRole('button', { name: 'Request void' }).first().click();
await page.locator('textarea').fill('Customer returned it straight away');
await page.getByRole('button', { name: 'Send request' }).click();
await page.getByText('VOID REQUESTED').first().waitFor();
await page.screenshot({ path: OUT + '07-my-sales.png' });

// 10. mobile layout
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const mp = await m.newPage();
await login(mp, 'snacks1', '736205');
await mp.waitForURL('**/pos');
await mp.getByText('[SAMPLE] Juice box').waitFor();
const snames = await mp.locator('.pcard .pname').allTextContents();
assert(snames.every((n) => n.startsWith('[SAMPLE]')), 'snacks cashier sees only Snacks products');
await mp.locator('.pcard').first().click();
await mp.screenshot({ path: OUT + '08-mobile-pos.png' });
await mp.locator('.cart-bar').click();
await mp.screenshot({ path: OUT + '09-mobile-cart.png' });
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
assert(overflow <= 0, `no horizontal scroll on phone (${overflow})`);

await browser.close();
await db.end();
console.log('CASHIER E2E PASSED');
