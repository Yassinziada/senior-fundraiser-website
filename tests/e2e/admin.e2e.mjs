// Optional browser end-to-end test (see tests/e2e/README.md).
// Runs against a LOCAL Supabase stack prepared by tests/e2e/setup-local.sh.
// Browser E2E: admin flows against the local Supabase stack.
import { chromium } from 'playwright';
import pg from 'pg';
import { writeFileSync, readFileSync } from 'node:fs';

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const RUN = Date.now().toString(36).slice(-5);
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
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
page.on('console', (m) => m.type() === 'error' && console.log('console.error', m.text()));
const nav = (name) => page.locator('.admin-tabs').getByRole('link', { name: new RegExp('^' + name) }).first().click();

// setup: the Bazaar cashier asks to void one of their sales
{
  const uid = (await q(`select id from profiles where username='bazaar1'`))[0].id;
  const t = (await q(`select t.id from transactions t where t.cashier_id=$1 and t.status='completed'
     and not exists (select 1 from void_requests v where v.transaction_id=t.id) order by created_at desc limit 1`, [uid]))[0].id;
  await db.query(`begin; set local role authenticated; select set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, role: 'authenticated' })}', true);
    select public.pos_request_void('${t}', 'E2E: wrong item rung up'); commit;`);
}

// login with email + password
await page.goto(BASE + '/login');
await page.getByPlaceholder('e.g. bazaar1').fill('coordinator@school.test');
await page.locator('input[type=password]').fill('AdminPass-2026!');
assert((await page.locator('.pinpad').count()) === 0, 'PIN pad hidden for email login');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL('**/admin');
await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
await page.locator('.kpi').first().waitFor();
await page.waitForTimeout(800);
const kpiText = await page.locator('.kpis').first().innerText();
const rev = (await q(`select coalesce(sum(total),0)::numeric r from transactions where status='completed'`))[0].r;
assert(kpiText.includes(Number(rev).toLocaleString('en-US')), `dashboard revenue matches DB (${rev})`);
assert((await page.locator('.tab .cnt').innerText()) === '1', 'pending void badge shows 1');
await page.screenshot({ path: OUT + '20-dashboard.png', fullPage: true });

// live update: a cashier sale on another "device" shows up without reload
const before = await page.locator('.kpis').first().innerText();
const bz = (await q(`select id from profiles where username='bazaar1'`))[0].id;
const caps = (await q(`select id from products where name='Caps'`))[0].id;
await db.query(`begin; set local role authenticated; select set_config('request.jwt.claims', $1, true);
  select public.pos_checkout(gen_random_uuid(), $2::jsonb, 'INSTAPAY'); commit;`.replace(/\$1/, `'${JSON.stringify({ sub: bz, role: 'authenticated' })}'`).replace('$2', `'[{"product_id":${caps},"quantity":1}]'`));
await page.waitForFunction((b) => document.querySelector('.kpis').innerText !== b, before, { timeout: 40000 });
assert(true, 'dashboard updated live after a sale on another device');

// approve the pending void -> stock restored once
await nav('Voids');
await page.getByRole('button', { name: 'Approve', exact: true }).first().waitFor();
const vr = (await q(`select v.id, v.transaction_id from void_requests v where status='pending'`))[0];
const items = await q(`select product_id, quantity from transaction_items where transaction_id=$1`, [vr.transaction_id]);
const stockBefore = (await q(`select stock from products where id=$1`, [items[0].product_id]))[0].stock;
await page.getByRole('button', { name: 'Approve', exact: true }).first().click();
await page.getByRole('button', { name: 'Approve void' }).click();
await page.getByText('Void approved, stock restored').waitFor();
const stockAfter = (await q(`select stock from products where id=$1`, [items[0].product_id]))[0].stock;
const tracked = (await q(`select track_stock from products where id=$1`, [items[0].product_id]))[0].track_stock;
assert(stockAfter === stockBefore + (tracked ? items[0].quantity : 0), `void restored stock once (${stockBefore} -> ${stockAfter})`);
assert((await q(`select status from transactions where id=$1`, [vr.transaction_id]))[0].status === 'voided', 'transaction marked voided');

// sales history with filters + detail with cost/profit + receipt
await nav('Sales');
await page.locator('tbody tr.clickable').first().waitFor();
const n = await page.locator('tbody tr.clickable').count();
assert(n >= 10, `sales history lists transactions (${n})`);
await page.getByLabel('Payment method').selectOption('TELDA');
await page.waitForTimeout(700);
const methods = await page.locator('tbody tr.clickable td:nth-child(6)').allTextContents();
assert(methods.length > 0 && methods.every((m) => m === 'Telda'), 'payment filter works');
await page.locator('tbody tr.clickable').first().click();
await page.getByText('Unit cost').waitFor();
await page.screenshot({ path: OUT + '21-txn-detail.png' });
await page.keyboard.press('Escape');
const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
const csvPath = OUT + 'sales.csv';
await dl.saveAs(csvPath);
const csv = readFileSync(csvPath, 'utf8');
assert(csv.startsWith('﻿') && csv.includes('Transaction,Date/time') && /BZR-\d{6}/.test(csv), 'sales CSV export downloads');

// products: cost visible to admin, edit cost -> historical sale keeps old cost
await nav('Products');
await page.getByText('Profit/item').waitFor();
await page.screenshot({ path: OUT + '22-products.png' });
const keyRow = page.locator('tbody tr', { has: page.locator('b', { hasText: /^Keychains$/ }) });
await keyRow.getByRole('button', { name: 'Edit' }).click();
await page.locator('.modal input[inputmode=decimal]').nth(1).fill('22.50');
await page.getByRole('button', { name: 'Save product' }).click();
await page.getByText('Product saved').waitFor();
const hist = await q(`select distinct unit_cost from transaction_items i join products p on p.id=i.product_id where p.name='Keychains'`);
assert(hist.length === 1 && Number(hist[0].unit_cost) === 20, 'past sales keep the old cost snapshot (20.00)');
assert(Number((await q(`select cost from product_costs c join products p on p.id=c.product_id where p.name='Keychains'`))[0].cost) === 22.5, 'new cost saved');

// stock adjustment needs a reason
await keyRow.getByRole('button', { name: 'Stock ±' }).click();
await page.locator('.modal input[inputmode=numeric]').fill('5');
assert(await page.getByRole('button', { name: 'Save adjustment' }).isDisabled(), 'adjustment blocked without reason');
await page.getByPlaceholder('e.g. Second box delivered').fill('Second box delivered');
await page.getByRole('button', { name: 'Save adjustment' }).click();
await page.getByText('Stock updated').waitFor();

// add a product with a photo upload
await page.getByRole('button', { name: '+ Add product' }).click();
await page.locator('.modal input').first().fill('Bookmark ' + RUN);
await page.locator('.modal input[inputmode=decimal]').nth(0).fill('12');
await page.locator('.modal input[inputmode=decimal]').nth(1).fill('4');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
writeFileSync(OUT + 'tiny.png', png);
await page.locator('.modal input[type=file]').setInputFiles(OUT + 'tiny.png');
await page.waitForFunction(() => document.querySelector('.modal .imgprev img'), null, { timeout: 20000 });
await page.getByRole('button', { name: 'Save product' }).click();
await page.waitForFunction(() => !document.querySelector('.modal'));
const bm = (await q(`select image_url, starting_stock from products where name=$1`, ['Bookmark ' + RUN]))[0];
assert(bm && /product-images\/products\/.*\.jpg$/.test(bm.image_url), 'photo uploaded to storage and linked');

// users: create a cashier through the UI (Edge Function)
await nav('Users');
await page.getByRole('button', { name: '+ Create cashier' }).click();
await page.getByPlaceholder('e.g. Bazaar Cashier').fill('Snacks Helper');
await page.getByPlaceholder('e.g. bazaar1').fill('snacks' + RUN);
await page.locator('.modal select').selectOption('SNACKS');
await page.locator('.modal input[type=password]').nth(0).fill('551903');
await page.locator('.modal input[type=password]').nth(1).fill('551903');
await page.getByRole('button', { name: 'Create', exact: true }).click();
await page.getByText('Snacks Helper created').waitFor();
const s2 = (await q(`select role, section_code, active from profiles where username=$1`, ['snacks' + RUN]))[0];
assert(s2 && s2.active && s2.section_code === 'SNACKS', 'new cashier is active in SNACKS');
await page.screenshot({ path: OUT + '23-users.png' });

// cash handover
await nav('Cash handover');
await page.getByText('End-of-day cash handover').waitFor();
await page.locator('.cell-in').first().waitFor();
const row = page.locator('tbody tr', { hasText: 'Bazaar Cashier' }).first();
const expected = (await q(`select sum(case when t.payment_method='CASH' then t.total else 0 end) s from transactions t join profiles p on p.id=t.cashier_id where p.username='bazaar1'`))[0].s;
await row.locator('.cell-in').fill(String(Number(expected) - 5));
await row.getByRole('button', { name: 'Record' }).click();
await page.getByText(/Handover recorded/).waitFor();
const h = (await q(`select expected_cash, actual_cash, difference from cash_handovers where superseded_at is null order by id desc limit 1`))[0];
log('handover', h);
assert(Number(h.difference) === Number(h.actual_cash) - Number(h.expected_cash), 'difference = actual - expected');
await page.screenshot({ path: OUT + '24-cash.png', fullPage: true });

// reports
await nav('Reports');
await page.getByRole('button', { name: 'Payment methods' }).click();
await page.getByText('Sales by payment method').waitFor();
await page.screenshot({ path: OUT + '25-reports-payments.png' });
for (const t of ['By product', 'By category', 'By cashier', 'Inventory', 'Voids / refunds', 'Cash reconciliation']) {
  await page.getByRole('button', { name: t }).click();
  await page.waitForTimeout(400);
}
assert(true, 'all report tabs render');

// import an ORIGINAL POS backup (piasters, with photo)
const backup = {
  app: 'bazaar-pos', schema: 1, exportedAt: new Date().toISOString(),
  data: {
    categories: [{ id: 'C1', name: 'Accessories' }, { id: 'C9', name: 'Posters' }],
    products: [
      { id: 'P050', name: 'Poster ' + RUN, categoryId: 'C9', cost: 1500, price: 4000, startStock: 10, stock: 8, minStock: 2, active: true, image: 'data:image/png;base64,' + png.toString('base64') },
      { id: 'P001', name: 'Phone charms', categoryId: 'C1', cost: 2500, price: 5000, stock: 20, minStock: 5, active: true },
    ],
    txns: [{ id: 'BZ-0001' }], users: [{ id: 'U1' }],
  },
};
writeFileSync(OUT + 'old-backup.json', JSON.stringify(backup));
await nav('Import');
await page.locator('input[type=file]').setInputFiles(OUT + 'old-backup.json');
await page.getByText('2 products found').waitFor();
await page.getByRole('button', { name: /Import 2 product/ }).click();
await page.getByText(/Imported 1 product/).waitFor();
const poster = (await q(`select p.price, c.cost, p.stock, p.image_url from products p join product_costs c on c.product_id=p.id where p.name=$1`, ['Poster ' + RUN]))[0];
assert(Number(poster.price) === 40 && Number(poster.cost) === 15 && poster.stock === 8 && poster.image_url, 'legacy import converts piasters, keeps stock and photo');
assert((await q(`select count(*)::int n from transactions where txn_no like 'BZ-0%'`))[0].n === 0, 'no legacy transactions imported');

// settings: currency is configurable
await nav('Settings');
await page.locator('input').nth(1).fill('USD');
await page.getByRole('button', { name: 'Save settings' }).click();
await page.getByText('Settings saved').waitFor();
await nav('Products');
await page.getByText(/USD/).first().waitFor();
assert(true, 'currency change applies to formatting');
await nav('Settings');
await page.locator('input').nth(1).fill('EGP');
await page.getByRole('button', { name: 'Save settings' }).click();
await page.getByText('Settings saved').waitFor();

// audit log
await nav('Audit log');
await page.locator('tbody').getByText('sale completed').first().waitFor();
const auditText = await page.locator('tbody').innerText();
for (const a of ['void approved', 'cost changed', 'stock adjusted', 'user created', 'cash handover recorded', 'settings changed', 'products imported', 'login']) {
  assert(auditText.includes(a), `audit shows "${a}"`);
}
await page.screenshot({ path: OUT + '26-audit.png' });

// admin can sell too
await nav('Sell');
await page.locator('.pcard').first().waitFor();
assert(true, 'admin sell page loads');

// mobile admin
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
const mp = await m.newPage();
await mp.goto(BASE + '/login');
await mp.getByPlaceholder('e.g. bazaar1').fill('coordinator@school.test');
await mp.locator('input[type=password]').fill('AdminPass-2026!');
await mp.getByRole('button', { name: 'Sign in' }).click();
await mp.waitForURL('**/admin');
await mp.locator('.kpi').first().waitFor();
await mp.screenshot({ path: OUT + '27-admin-mobile.png' });
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
assert(overflow <= 0, `admin dashboard has no horizontal scroll on phone (${overflow})`);

await browser.close();
await db.end();
console.log('ADMIN E2E PASSED');
