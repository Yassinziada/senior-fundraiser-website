// End-to-end database tests: security (RLS + grants), checkout, concurrency,
// idempotency, voids, reports, cash handover, audit and immutability.
//
// Run:  TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm run test:db
// Uses a DISPOSABLE database called pos_test on that server.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TEST_URL, createTestDatabase, createUser, as, rpc, num } from './db-helpers.js';

const d = TEST_URL ? describe : describe.skip;

d('School Bazaar POS database', () => {
  let pool;
  let admin, bazaar, snacks, bazaar2, pending;
  const product = {}; // name -> row (read as admin)

  const checkout = (uid, items, method = 'CASH', received = null, opts = {}) =>
    rpc(pool, uid, 'pos_checkout', [
      opts.key ?? randomUUID(),
      JSON.stringify(items),
      method,
      received,
      opts.expectedTotal ?? null,
      opts.section ?? null,
    ]);

  const stockOf = async (id) => (await pool.query('select stock from products where id = $1', [id])).rows[0].stock;
  const errOf = async (p) => {
    try {
      await p;
    } catch (e) {
      return e;
    }
    throw new Error('expected an error');
  };

  beforeAll(async () => {
    pool = await createTestDatabase();
    admin = await createUser(pool, { email: 'admin@test.local', role: 'admin', username: 'admin', fullName: 'Admin' });
    bazaar = await createUser(pool, { email: 'bazaar@test.local', role: 'cashier', section: 'BAZAAR', username: 'bazaar' });
    snacks = await createUser(pool, { email: 'snacks@test.local', role: 'cashier', section: 'SNACKS', username: 'snacks' });
    bazaar2 = await createUser(pool, { email: 'bazaar2@test.local', role: 'cashier', section: 'BAZAAR', username: 'bazaar2', oneStep: true });
    // a user created in the Supabase dashboard (no pos_* metadata)
    pending = await createUser(pool, { email: 'stranger@test.local', rawMeta: { provider: 'email' } });
    const rows = await as(pool, admin, 'select id, name, section_code, price, stock from products');
    for (const r of rows) product[r.name] = { ...r, id: Number(r.id) };
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  // ---------------------------------------------------------------- accounts
  describe('accounts & login', () => {
    it('creates active profiles for admin and cashiers, inactive for unknown users', async () => {
      const { rows } = await pool.query('select username, role, section_code, active from profiles order by username');
      const by = Object.fromEntries(rows.map((r) => [r.username, r]));
      expect(by.admin).toMatchObject({ role: 'admin', section_code: null, active: true });
      expect(by.bazaar).toMatchObject({ role: 'cashier', section_code: 'BAZAAR', active: true });
      expect(by.snacks).toMatchObject({ role: 'cashier', section_code: 'SNACKS', active: true });
      expect(by.stranger).toMatchObject({ active: false });
    });

    it('profile picks up role/section whether Auth writes metadata on insert or in a later update', async () => {
      const { rows } = await pool.query(`select username, full_name, active, section_code from profiles where id = any($1)`, [[bazaar, bazaar2]]);
      expect(rows.every((r) => r.active && r.section_code === 'BAZAAR')).toBe(true);
      // a later sign-in rewrites provider info but must not change anything
      await pool.query(`update profiles set section_code = 'SNACKS' where id = $1`, [bazaar2]);
      await pool.query(`update auth.users set raw_app_meta_data = raw_app_meta_data || '{"providers":["email"]}' where id = $1`, [bazaar2]);
      const { rows: r2 } = await pool.query('select section_code from profiles where id = $1', [bazaar2]);
      expect(r2[0].section_code).toBe('SNACKS');
      await pool.query(`update profiles set section_code = 'BAZAAR' where id = $1`, [bazaar2]);
    });

    it('a user can read only their own profile (cashier cannot list other accounts)', async () => {
      const rows = await as(pool, bazaar, 'select username from profiles');
      expect(rows.map((r) => r.username)).toEqual(['bazaar']);
      const all = await as(pool, admin, 'select username from profiles');
      expect(all.length).toBe(5);
    });

    it('an inactive (pending) user sees no products and cannot sell', async () => {
      expect(await as(pool, pending, 'select id from products')).toEqual([]);
      const e = await errOf(checkout(pending, [{ product_id: product['Keychains'].id, quantity: 1 }]));
      expect(e.hint).toBe('FORBIDDEN');
    });

    it('log_login writes an audit entry', async () => {
      await rpc(pool, bazaar, 'log_login');
      const { rows } = await pool.query(`select count(*)::int n from audit_logs where action = 'login' and actor_id = $1`, [bazaar]);
      expect(rows[0].n).toBe(1);
    });

    it('make_admin (bootstrap) is not callable through the API', async () => {
      const e = await errOf(rpc(pool, bazaar, 'make_admin', ['bazaar@test.local']));
      expect(e.code).toBe('42501');
      const e2 = await errOf(rpc(pool, null, 'make_admin', ['bazaar@test.local']));
      expect(e2.code).toBe('42501');
    });
  });

  // ---------------------------------------------------------------- RLS / authorization
  describe('authorization (RLS & grants)', () => {
    it('Bazaar cashier sees ONLY active Bazaar products; Snacks cashier ONLY Snacks', async () => {
      const b = await as(pool, bazaar, 'select distinct section_code from products');
      expect(b).toEqual([{ section_code: 'BAZAAR' }]);
      const s = await as(pool, snacks, 'select distinct section_code from products');
      expect(s).toEqual([{ section_code: 'SNACKS' }]);
      // even an explicit filter for the other section returns nothing
      expect(await as(pool, snacks, `select id from products where section_code = 'BAZAAR'`)).toEqual([]);
      expect(await as(pool, snacks, `select id from categories where section_code = 'BAZAAR'`)).toEqual([]);
    });

    it('admin sees both sections', async () => {
      const rows = await as(pool, admin, 'select distinct section_code from products order by 1');
      expect(rows.map((r) => r.section_code)).toEqual(['BAZAAR', 'SNACKS']);
    });

    it('cashier cannot read cost, profit or any admin table', async () => {
      // products has no cost column at all
      const e = await errOf(as(pool, bazaar, 'select cost from products'));
      expect(e.code).toBe('42703');
      for (const t of ['product_costs', 'transactions', 'transaction_items', 'void_requests', 'stock_movements', 'cash_handovers', 'audit_logs']) {
        expect(await as(pool, bazaar, `select * from ${t}`), t).toEqual([]);
      }
    });

    it('anonymous visitors (only the public anon key) can read nothing but the login info', async () => {
      const e = await errOf(as(pool, null, 'select * from products'));
      expect(e.code).toBe('42501');
      const info = await rpc(pool, null, 'public_app_info');
      expect(Object.keys(info).sort()).toEqual(['currency_code', 'event_name', 'locale']);
      const e2 = await errOf(rpc(pool, null, 'pos_checkout', [randomUUID(), '[]', 'CASH', null, null, null]));
      expect(e2.code).toBe('42501');
    });

    it('no API role can write tables directly (price/stock edits, fake sales, audit tampering)', async () => {
      const id = product['Keychains'].id;
      for (const uid of [bazaar, admin]) {
        expect((await errOf(as(pool, uid, 'update products set price = 1, stock = 999 where id = $1', [id]))).code).toBe('42501');
        expect((await errOf(as(pool, uid, `insert into audit_logs (action) values ('x')`))).code).toBe('42501');
        expect((await errOf(as(pool, uid, 'delete from audit_logs'))).code).toBe('42501');
        expect((await errOf(as(pool, uid, 'update product_costs set cost = 0'))).code).toBe('42501');
      }
    });

    it('cashier cannot call admin functions', async () => {
      const calls = [
        ['admin_products_overview', [null]],
        ['admin_sales_report', ['2000-01-01', '2100-01-01', null]],
        ['admin_inventory_summary', [null]],
        ['admin_adjust_stock', [product['Keychains'].id, 'add', 5, 'test reason']],
        ['admin_save_product', [JSON.stringify({ section_code: 'BAZAAR', name: 'Hack', price: 1 })]],
        ['admin_update_settings', [JSON.stringify({ event_name: 'x' })]],
        ['admin_cash_summary', ['2026-01-01', null]],
      ];
      for (const [fn, args] of calls) {
        const e = await errOf(rpc(pool, bazaar, fn, args));
        expect(e.hint, fn).toBe('FORBIDDEN');
      }
      // cashier cannot promote themselves
      const e = await errOf(as(pool, bazaar, `select public.admin_update_user($1, 'x', 'admin', null, true)`, [bazaar]));
      expect(e.hint).toBe('FORBIDDEN');
    });

    it('internal helper functions are not exposed to the API', async () => {
      for (const sql of [
        `select public._audit('x', null, null, null, '{}')`,
        `select public._receipt_json(gen_random_uuid())`,
        `select * from public._cash_figures(current_date)`,
      ]) {
        const e = await errOf(as(pool, bazaar, sql));
        expect(e.code).toBe('42501');
      }
    });
  });

  // ---------------------------------------------------------------- checkout
  describe('checkout', () => {
    it('cash sale: correct total, change, stock decreases once, movement + audit written', async () => {
      const p = product['Keychains']; // 40.00, stock 20
      const before = await stockOf(p.id);
      const r = await checkout(bazaar, [{ product_id: p.id, quantity: 2 }], 'CASH', 100);
      expect(num(r.total)).toBe(80);
      expect(num(r.amount_received)).toBe(100);
      expect(num(r.change_given)).toBe(20);
      expect(r.payment_method).toBe('CASH');
      expect(r.txn_no).toMatch(/^BZR-\d{6}$/);
      expect(r.duplicate).toBe(false);
      expect(r.items).toEqual([expect.objectContaining({ product_name: 'Keychains', quantity: 2 })]);
      expect(r.items[0]).not.toHaveProperty('unit_cost');
      expect(await stockOf(p.id)).toBe(before - 2);
      const mv = await pool.query(`select * from stock_movements where transaction_id = $1`, [r.id]);
      expect(mv.rows).toHaveLength(1);
      expect(mv.rows[0]).toMatchObject({ movement_type: 'sale', quantity_change: -2, stock_before: before, stock_after: before - 2 });
      const au = await pool.query(`select * from audit_logs where action = 'sale_completed' and entity_id = $1`, [r.id]);
      expect(au.rows).toHaveLength(1);
    });

    it('stores price and cost snapshots on each line', async () => {
      const p = product['Caps']; // price 130, cost 70
      const r = await checkout(bazaar, [{ product_id: p.id, quantity: 3 }], 'TELDA');
      const { rows } = await pool.query('select * from transaction_items where transaction_id = $1', [r.id]);
      expect(rows[0]).toMatchObject({ unit_price: '130.00', unit_cost: '70.00', line_total: '390.00', line_cost: '210.00', section_code: 'BAZAAR' });
      const t = (await pool.query('select * from transactions where id = $1', [r.id])).rows[0];
      expect(t).toMatchObject({ total: '390.00', total_cost: '210.00', amount_received: null, change_given: null });
    });

    it('Telda and InstaPay sales record the method and no cash fields', async () => {
      const p = product['Gel pens'];
      const a = await checkout(bazaar, [{ product_id: p.id, quantity: 1 }], 'TELDA', 500);
      const b = await checkout(bazaar, [{ product_id: p.id, quantity: 1 }], 'INSTAPAY');
      expect(a.payment_method).toBe('TELDA');
      expect(a.amount_received).toBeNull();
      expect(b.payment_method).toBe('INSTAPAY');
      expect(b.change_given).toBeNull();
    });

    it('rejects cash below the total, and missing cash amount', async () => {
      const p = product['Caps'];
      expect((await errOf(checkout(bazaar, [{ product_id: p.id, quantity: 1 }], 'CASH', 129.99))).hint).toBe('CASH_TOO_LOW');
      expect((await errOf(checkout(bazaar, [{ product_id: p.id, quantity: 1 }], 'CASH', null))).hint).toBe('CASH_REQUIRED');
    });

    it('computes change exactly with decimals', async () => {
      const id = await rpc(pool, admin, 'admin_save_product', [
        JSON.stringify({ section_code: 'SNACKS', name: 'Decimal test', price: 12.35, cost: 3.1, starting_stock: 10 }),
      ]);
      const r = await checkout(snacks, [{ product_id: Number(id), quantity: 3 }], 'CASH', 50);
      expect(r.total).toBe(37.05);
      expect(r.change_given).toBe(12.95);
    });

    it('cashier cannot sell another section\'s product or pick another section', async () => {
      const e = await errOf(checkout(snacks, [{ product_id: product['Keychains'].id, quantity: 1 }], 'TELDA'));
      expect(e.hint).toBe('WRONG_SECTION');
      const e2 = await errOf(checkout(snacks, [{ product_id: product['[SAMPLE] Chips'].id, quantity: 1 }], 'TELDA', null, { section: 'BAZAAR' }));
      expect(e2.hint).toBe('FORBIDDEN');
    });

    it('admin can sell but must choose a section', async () => {
      const p = product['[SAMPLE] Chips'];
      expect((await errOf(checkout(admin, [{ product_id: p.id, quantity: 1 }], 'INSTAPAY'))).hint).toBe('SECTION_REQUIRED');
      const r = await checkout(admin, [{ product_id: p.id, quantity: 1 }], 'INSTAPAY', null, { section: 'SNACKS' });
      expect(r.section_code).toBe('SNACKS');
    });

    it('rejects invalid carts', async () => {
      const p = product['Keychains'];
      expect((await errOf(checkout(bazaar, []))).hint).toBe('EMPTY_CART');
      expect((await errOf(checkout(bazaar, [{ product_id: p.id, quantity: 0 }], 'TELDA'))).hint).toBe('BAD_QUANTITY');
      expect((await errOf(checkout(bazaar, [{ product_id: p.id, quantity: 1.5 }], 'TELDA'))).hint).toBe('BAD_QUANTITY');
      expect((await errOf(checkout(bazaar, [{ product_id: p.id, quantity: -3 }], 'TELDA'))).hint).toBe('BAD_QUANTITY');
      expect((await errOf(checkout(bazaar, [{ product_id: 999999, quantity: 1 }], 'TELDA'))).hint).toBe('PRODUCT_NOT_FOUND');
    });

    it('cannot sell more than the stock', async () => {
      const p = product['Mini rulers'];
      const s = await stockOf(p.id);
      const e = await errOf(checkout(bazaar, [{ product_id: p.id, quantity: s + 1 }], 'TELDA'));
      expect(e.hint).toBe('INSUFFICIENT_STOCK');
      expect(await stockOf(p.id)).toBe(s); // nothing changed
    });

    it('duplicate cart lines for the same product are merged and checked together', async () => {
      const p = product['Mini rulers'];
      const s = await stockOf(p.id);
      const e = await errOf(checkout(bazaar, [{ product_id: p.id, quantity: s }, { product_id: p.id, quantity: 1 }], 'TELDA'));
      expect(e.hint).toBe('INSUFFICIENT_STOCK');
    });

    it('refuses when prices changed since the cart was built (PRICE_CHANGED)', async () => {
      const p = product['Erasers']; // 10.00
      const e = await errOf(checkout(bazaar, [{ product_id: p.id, quantity: 1 }], 'TELDA', null, { expectedTotal: 9 }));
      expect(e.hint).toBe('PRICE_CHANGED');
      const ok = await checkout(bazaar, [{ product_id: p.id, quantity: 1 }], 'TELDA', null, { expectedTotal: 10 });
      expect(num(ok.total)).toBe(10);
    });

    it('inactive products cannot be sold', async () => {
      const p = product['Highlighters'];
      await rpc(pool, admin, 'admin_set_product_active', [p.id, false]);
      expect(await as(pool, bazaar, 'select id from products where id = $1', [p.id])).toEqual([]);
      expect((await errOf(checkout(bazaar, [{ product_id: p.id, quantity: 1 }], 'TELDA'))).hint).toBe('PRODUCT_INACTIVE');
      await rpc(pool, admin, 'admin_set_product_active', [p.id, true]);
    });

    it('services (no stock tracking) sell without touching stock', async () => {
      const p = product['Face painting (small design)'];
      const r = await checkout(bazaar, [{ product_id: p.id, quantity: 60 }], 'CASH', 1800);
      expect(num(r.total)).toBe(1800);
      expect(await stockOf(p.id)).toBe(0);
      const mv = await pool.query('select count(*)::int n from stock_movements where transaction_id = $1', [r.id]);
      expect(mv.rows[0].n).toBe(0);
    });
  });

  // ---------------------------------------------------------------- idempotency & races
  describe('duplicate & concurrent checkout protection', () => {
    it('re-sending the same checkout key returns the original sale (no double sale, stock once)', async () => {
      const p = product['Scrunchies'];
      const s = await stockOf(p.id);
      const key = randomUUID();
      const a = await checkout(bazaar, [{ product_id: p.id, quantity: 1 }], 'CASH', 50, { key });
      const b = await checkout(bazaar, [{ product_id: p.id, quantity: 1 }], 'CASH', 50, { key });
      expect(b.id).toBe(a.id);
      expect(b.duplicate).toBe(true);
      expect(await stockOf(p.id)).toBe(s - 1);
      const n = await pool.query('select count(*)::int n from transactions where idempotency_key = $1', [key]);
      expect(n.rows[0].n).toBe(1);
    });

    it('double-click: 5 simultaneous requests with the same key create exactly one sale', async () => {
      const p = product['Pencil cases'];
      const s = await stockOf(p.id);
      const key = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => checkout(bazaar, [{ product_id: p.id, quantity: 1 }], 'TELDA', null, { key })),
      );
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(results.filter((r) => r.duplicate === false)).toHaveLength(1);
      expect(await stockOf(p.id)).toBe(s - 1);
    });

    it('checkout status lookup tells whether a key already succeeded', async () => {
      const p = product['Pencil cases'];
      const key = randomUUID();
      expect(await rpc(pool, bazaar, 'pos_checkout_status', [key])).toBeNull();
      const r = await checkout(bazaar, [{ product_id: p.id, quantity: 1 }], 'TELDA', null, { key });
      expect((await rpc(pool, bazaar, 'pos_checkout_status', [key])).id).toBe(r.id);
      // another cashier cannot probe it
      expect(await rpc(pool, bazaar2, 'pos_checkout_status', [key])).toBeNull();
    });

    it('another user cannot reuse someone else\'s checkout key', async () => {
      const p = product['Pencil cases'];
      const key = randomUUID();
      await checkout(bazaar, [{ product_id: p.id, quantity: 1 }], 'TELDA', null, { key });
      const e = await errOf(checkout(bazaar2, [{ product_id: p.id, quantity: 1 }], 'TELDA', null, { key }));
      expect(e.code).toBe('42501');
    });

    it('two cashiers buying the LAST item at the same moment: exactly one succeeds', async () => {
      const p = product['Stress balls'];
      const s = await stockOf(p.id);
      await rpc(pool, admin, 'admin_adjust_stock', [p.id, 'set', 1, 'race test']);
      const results = await Promise.allSettled([
        checkout(bazaar, [{ product_id: p.id, quantity: 1 }], 'TELDA'),
        checkout(bazaar2, [{ product_id: p.id, quantity: 1 }], 'TELDA'),
        checkout(admin, [{ product_id: p.id, quantity: 1 }], 'TELDA', null, { section: 'BAZAAR' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toHaveLength(2);
      for (const r of rejected) expect(r.reason.hint).toBe('INSUFFICIENT_STOCK');
      expect(await stockOf(p.id)).toBe(0);
      await rpc(pool, admin, 'admin_adjust_stock', [p.id, 'set', s, 'restore after race test']);
    });

    it('many concurrent sales never oversell', async () => {
      const p = product['Fidget toys'];
      await rpc(pool, admin, 'admin_adjust_stock', [p.id, 'set', 7, 'oversell test']);
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) => checkout(i % 2 ? bazaar : bazaar2, [{ product_id: p.id, quantity: 1 }], 'INSTAPAY')),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(7);
      expect(await stockOf(p.id)).toBe(0);
    });
  });

  // ---------------------------------------------------------------- voids
  describe('void workflow', () => {
    let sale;
    it('cashier requests a void with a mandatory reason', async () => {
      const p = product['Squishy toys'];
      sale = await checkout(bazaar, [{ product_id: p.id, quantity: 3 }], 'CASH', 200);
      expect((await errOf(rpc(pool, bazaar, 'pos_request_void', [sale.id, '  ']))).hint).toBe('REASON_REQUIRED');
      const r = await rpc(pool, bazaar, 'pos_request_void', [sale.id, 'Rang 3 instead of 2']);
      expect(r.status).toBe('pending');
      expect((await errOf(rpc(pool, bazaar, 'pos_request_void', [sale.id, 'again please']))).hint).toBe('ALREADY_REQUESTED');
      sale.requestId = r.void_request_id;
    });

    it('a cashier cannot request a void for another cashier\'s sale', async () => {
      const e = await errOf(rpc(pool, bazaar2, 'pos_request_void', [sale.id, 'not mine']));
      expect(e.hint).toBe('FORBIDDEN');
    });

    it('a cashier cannot approve a void (not even their own)', async () => {
      const e = await errOf(rpc(pool, bazaar, 'admin_decide_void', [sale.requestId, true, null]));
      expect(e.hint).toBe('FORBIDDEN');
      const t = (await pool.query('select status from transactions where id = $1', [sale.id])).rows[0];
      expect(t.status).toBe('completed');
    });

    it('admin approval voids the sale and restores stock exactly once', async () => {
      const p = product['Squishy toys'];
      const s = await stockOf(p.id);
      const r = await rpc(pool, admin, 'admin_decide_void', [sale.requestId, true, 'ok']);
      expect(r.status).toBe('approved');
      expect(num(r.refund_amount)).toBe(150);
      expect(await stockOf(p.id)).toBe(s + 3);
      const t = (await pool.query('select * from transactions where id = $1', [sale.id])).rows[0];
      expect(t.status).toBe('voided');
      expect(t.voided_by).toBe(admin);
      expect(t.voided_at).not.toBeNull();
      const vr = (await pool.query('select * from void_requests where id = $1', [sale.requestId])).rows[0];
      expect(vr).toMatchObject({ status: 'approved', decided_by: admin });

      // approving again (or concurrently) cannot restore twice
      expect((await errOf(rpc(pool, admin, 'admin_decide_void', [sale.requestId, true, null]))).hint).toBe('ALREADY_DECIDED');
      expect((await errOf(rpc(pool, admin, 'admin_void_transaction', [sale.id, 'again']))).hint).toBe('ALREADY_VOIDED');
      expect((await errOf(rpc(pool, bazaar, 'pos_request_void', [sale.id, 'again']))).hint).toBe('ALREADY_VOIDED');
      expect(await stockOf(p.id)).toBe(s + 3);
      const mv = await pool.query(`select count(*)::int n from stock_movements where transaction_id = $1 and movement_type = 'void_restore'`, [sale.id]);
      expect(mv.rows[0].n).toBe(1);
      const au = await pool.query(`select count(*)::int n from audit_logs where action in ('void_requested','void_approved') and entity_id = $1`, [sale.id]);
      expect(au.rows[0].n).toBe(2);
    });

    it('database itself refuses a second stock restore for the same sale', async () => {
      const e = await errOf(
        pool.query(
          `insert into stock_movements (product_id, section_code, movement_type, quantity_change, stock_before, stock_after, transaction_id)
           values ($1, 'BAZAAR', 'void_restore', 3, 0, 3, $2)`,
          [product['Squishy toys'].id, sale.id],
        ),
      );
      expect(e.code).toBe('23505');
    });

    it('two admins approving the same request concurrently restore stock once', async () => {
      const p = product['Claw clips'];
      const t = await checkout(bazaar, [{ product_id: p.id, quantity: 2 }], 'TELDA');
      const { void_request_id } = await rpc(pool, bazaar, 'pos_request_void', [t.id, 'customer changed mind']);
      const s = await stockOf(p.id);
      const res = await Promise.allSettled([
        rpc(pool, admin, 'admin_decide_void', [void_request_id, true, null]),
        rpc(pool, admin, 'admin_decide_void', [void_request_id, true, null]),
        rpc(pool, admin, 'admin_decide_void', [void_request_id, false, null]),
      ]);
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const final = (await pool.query('select status from void_requests where id = $1', [void_request_id])).rows[0].status;
      expect(await stockOf(p.id)).toBe(final === 'approved' ? s + 2 : s);
    });

    it('rejection keeps the sale valid and records who rejected it', async () => {
      const p = product['Keychains'];
      const t = await checkout(bazaar, [{ product_id: p.id, quantity: 1 }], 'TELDA');
      const s = await stockOf(p.id);
      const { void_request_id } = await rpc(pool, bazaar, 'pos_request_void', [t.id, 'wrong button']);
      const r = await rpc(pool, admin, 'admin_decide_void', [void_request_id, false, 'customer kept it']);
      expect(r.status).toBe('rejected');
      const vr = (await pool.query('select * from void_requests where id = $1', [void_request_id])).rows[0];
      expect(vr).toMatchObject({ status: 'rejected', decided_by: admin, decision_note: 'customer kept it' });
      expect(vr.decided_at).not.toBeNull();
      expect((await pool.query('select status from transactions where id = $1', [t.id])).rows[0].status).toBe('completed');
      expect(await stockOf(p.id)).toBe(s);
    });

    it('cashier history shows own sales only, with void status and without cost', async () => {
      const list = await rpc(pool, bazaar, 'pos_my_transactions', [50]);
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((t) => t.cashier_id === bazaar)).toBe(true);
      expect(JSON.stringify(list)).not.toMatch(/cost|profit/);
      expect(list.find((t) => t.id === sale.id).status).toBe('voided');
    });
  });

  // ---------------------------------------------------------------- inventory
  describe('inventory administration', () => {
    it('stock adjustments need a reason, never go negative, and are recorded', async () => {
      const p = product['Mini notebooks'];
      const s = await stockOf(p.id);
      expect((await errOf(rpc(pool, admin, 'admin_adjust_stock', [p.id, 'add', 5, '']))).hint).toBe('REASON_REQUIRED');
      expect((await errOf(rpc(pool, admin, 'admin_adjust_stock', [p.id, 'remove', s + 1, 'too many']))).hint).toBe('INSUFFICIENT_STOCK');
      const r = await rpc(pool, admin, 'admin_adjust_stock', [p.id, 'add', 5, 'New delivery']);
      expect(r.stock).toBe(s + 5);
      const r2 = await rpc(pool, admin, 'admin_adjust_stock', [p.id, 'set', 3, 'Physical count']);
      expect(r2.change).toBe(-(s + 2));
      const mv = await pool.query(`select movement_type, quantity_change, reason from stock_movements where product_id = $1 and movement_type::text like 'adjust%' order by id`, [p.id]);
      expect(mv.rows).toEqual([
        { movement_type: 'adjust_add', quantity_change: 5, reason: 'New delivery' },
        { movement_type: 'adjust_remove', quantity_change: -(s + 2), reason: 'Physical count' },
      ]);
      const au = await pool.query(`select count(*)::int n from audit_logs where action = 'stock_adjusted' and entity_id = $1`, [String(p.id)]);
      expect(au.rows[0].n).toBe(2);
    });

    it('historical revenue/COGS do not change when price or cost is edited later', async () => {
      const id = Number(
        await rpc(pool, admin, 'admin_save_product', [
          JSON.stringify({ section_code: 'SNACKS', name: 'History test', price: 20, cost: 8, starting_stock: 10 }),
        ]),
      );
      await checkout(snacks, [{ product_id: id, quantity: 2 }], 'CASH', 40);
      const today = (await pool.query(`select public.business_date_of(now())::text d`)).rows[0].d;
      const before = await rpc(pool, admin, 'admin_sales_report', [today, today, 'SNACKS']);
      const lineBefore = before.by_product.find((x) => x.product_id === id);
      expect(lineBefore).toMatchObject({ units: 2, revenue: 40, cogs: 16, gross_profit: 24 });

      await rpc(pool, admin, 'admin_save_product', [
        JSON.stringify({ id, section_code: 'SNACKS', name: 'History test', price: 99, cost: 50, min_stock: 1 }),
      ]);
      const after = await rpc(pool, admin, 'admin_sales_report', [today, today, 'SNACKS']);
      expect(after.by_product.find((x) => x.product_id === id)).toMatchObject({ units: 2, revenue: 40, cogs: 16, gross_profit: 24 });
      const au = await pool.query(`select action from audit_logs where entity_id = $1 and action in ('price_changed','cost_changed') order by id`, [String(id)]);
      expect(au.rows.map((r) => r.action)).toEqual(['price_changed', 'cost_changed']);
    });

    it('product overview (admin) includes cost, profit per item, margin and sold qty', async () => {
      const list = await rpc(pool, admin, 'admin_products_overview', ['BAZAAR']);
      const caps = list.find((x) => x.name === 'Caps');
      expect(caps).toMatchObject({ price: 130, cost: 70, profit_per_item: 60, margin_pct: 46.2 });
      expect(caps.sold_qty).toBeGreaterThanOrEqual(3);
    });

    it('a product cannot be placed in the other section\'s category', async () => {
      const cat = (await pool.query(`select id from categories where section_code = 'SNACKS' limit 1`)).rows[0].id;
      const e = await errOf(
        rpc(pool, admin, 'admin_save_product', [JSON.stringify({ section_code: 'BAZAAR', category_id: cat, name: 'X', price: 1 })]),
      );
      expect(e.message).toMatch(/different section/);
    });

    it('import creates categories and skips existing names', async () => {
      const r = await rpc(pool, admin, 'admin_import_products', [
        JSON.stringify([
          { section_code: 'SNACKS', category: 'Imported cat', name: 'Imported A', price: 5, cost: 2, stock: 4 },
          { section_code: 'BAZAAR', category: 'Accessories', name: 'Caps', price: 5, cost: 2, stock: 4 },
        ]),
      ]);
      expect(r).toMatchObject({ created: 1, categories_created: 1, skipped: ['Caps'] });
    });
  });

  // ---------------------------------------------------------------- reports & cash
  describe('reports & end-of-day cash', () => {
    let today;
    let cashier;
    beforeAll(async () => {
      today = (await pool.query(`select public.business_date_of(now())::text d`)).rows[0].d;
      cashier = await createUser(pool, { email: 'cash@test.local', role: 'cashier', section: 'SNACKS', username: 'cashtest' });
    });

    it('expected physical cash counts CASH only and subtracts approved cash voids', async () => {
      const p = product['[SAMPLE] Water bottle']; // 10.00
      const c1 = await checkout(cashier, [{ product_id: p.id, quantity: 3 }], 'CASH', 50); // 30
      await checkout(cashier, [{ product_id: p.id, quantity: 2 }], 'CASH', 20); // 20
      await checkout(cashier, [{ product_id: p.id, quantity: 4 }], 'TELDA'); // 40
      await checkout(cashier, [{ product_id: p.id, quantity: 5 }], 'INSTAPAY'); // 50
      const tv = await checkout(cashier, [{ product_id: p.id, quantity: 1 }], 'TELDA'); // 10, voided later
      const { void_request_id } = await rpc(pool, cashier, 'pos_request_void', [c1.id, 'test refund']);
      await rpc(pool, admin, 'admin_decide_void', [void_request_id, true, null]);
      await rpc(pool, admin, 'admin_void_transaction', [tv.id, 'duplicate']);

      const rows = await rpc(pool, admin, 'admin_cash_summary', [today, 'SNACKS']);
      const me = rows.find((r) => r.cashier_id === cashier);
      expect(me).toMatchObject({
        cash_sales: 50, // 30 + 20 received during the day
        cash_refunds: 30, // voided cash sale
        expected_cash: 20,
        telda_sales: 40, // net of the voided Telda sale; never in the box
        instapay_sales: 50,
        transaction_count: 3,
      });

      const rec = await rpc(pool, admin, 'admin_record_handover', [today, 'SNACKS', cashier, 15.5, 'short']);
      expect(rec).toMatchObject({ expected_cash: 20, actual_cash: 15.5, difference: -4.5 });
      // re-count supersedes, nothing deleted
      const rec2 = await rpc(pool, admin, 'admin_record_handover', [today, 'SNACKS', cashier, 20, 'found it']);
      expect(rec2.difference).toBe(0);
      const all = await pool.query('select superseded_at from cash_handovers where cashier_id = $1 order by id', [cashier]);
      expect(all.rows).toHaveLength(2);
      expect(all.rows[0].superseded_at).not.toBeNull();
      expect(all.rows[1].superseded_at).toBeNull();
      const again = await rpc(pool, admin, 'admin_cash_summary', [today, 'SNACKS']);
      expect(again.find((r) => r.cashier_id === cashier).handover.actual_cash).toBe(20);
    });

    it('sales report splits by section and payment method and excludes voids', async () => {
      const r = await rpc(pool, admin, 'admin_sales_report', [today, today, null]);
      const { rows } = await pool.query(
        `select coalesce(sum(total),0)::numeric revenue, coalesce(sum(total_cost),0)::numeric cogs, count(*)::int n,
                coalesce(sum(total) filter (where payment_method='CASH'),0)::numeric cash,
                coalesce(sum(total) filter (where payment_method='TELDA'),0)::numeric telda,
                coalesce(sum(total) filter (where payment_method='INSTAPAY'),0)::numeric instapay
           from transactions where status = 'completed'`,
      );
      const x = rows[0];
      expect(r.totals.revenue).toBe(num(x.revenue));
      expect(r.totals.cogs).toBe(num(x.cogs));
      expect(r.totals.transactions).toBe(x.n);
      expect(r.totals.cash + r.totals.telda + r.totals.instapay).toBeCloseTo(r.totals.revenue, 2);
      expect(r.totals.cash).toBe(num(x.cash));
      expect(r.totals.telda).toBe(num(x.telda));
      expect(r.totals.instapay).toBe(num(x.instapay));
      const sumSections = r.by_section.reduce((a, s) => a + s.revenue, 0);
      expect(sumSections).toBeCloseTo(r.totals.revenue, 2);
      expect(r.totals.voided_count).toBeGreaterThanOrEqual(3);
      const snacksOnly = await rpc(pool, admin, 'admin_sales_report', [today, today, 'SNACKS']);
      expect(snacksOnly.by_section.map((s) => s.section_code)).toEqual(['SNACKS']);
      expect(snacksOnly.by_product.every((p) => p.section_code === 'SNACKS')).toBe(true);
    });

    it('inventory summary reports low/out of stock and stock value', async () => {
      const inv = await rpc(pool, admin, 'admin_inventory_summary', [null]);
      expect(inv.out_of_stock.map((p) => p.name)).toContain('Fidget toys');
      expect(inv.stock_cost_value).toBeGreaterThan(0);
      expect(inv.low_stock.map((p) => p.name)).toContain('Mini notebooks'); // stock 3 <= min 5
    });
  });

  // ---------------------------------------------------------------- settings & users
  describe('settings, users, audit & immutability', () => {
    it('settings change is validated and audited', async () => {
      expect((await errOf(rpc(pool, admin, 'admin_update_settings', [JSON.stringify({ timezone: 'Mars/Base' })]))).code).toBeTruthy();
      await rpc(pool, admin, 'admin_update_settings', [JSON.stringify({ event_name: 'Spring Bazaar', currency_code: 'egp' })]);
      const s = (await as(pool, snacks, 'select event_name, currency_code from app_settings'))[0];
      expect(s).toEqual({ event_name: 'Spring Bazaar', currency_code: 'EGP' });
      const au = await pool.query(`select count(*)::int n from audit_logs where action = 'settings_changed'`);
      expect(au.rows[0].n).toBe(1);
    });

    it('admin can reassign / deactivate a cashier; deactivation cuts access immediately', async () => {
      await rpc(pool, admin, 'admin_update_user', [bazaar2, 'Second', 'cashier', 'SNACKS', true]);
      expect(await as(pool, bazaar2, `select distinct section_code from products`)).toEqual([{ section_code: 'SNACKS' }]);
      await rpc(pool, admin, 'admin_update_user', [bazaar2, 'Second', 'cashier', 'SNACKS', false]);
      expect(await as(pool, bazaar2, 'select id from products')).toEqual([]);
      const e = await errOf(checkout(bazaar2, [{ product_id: product['[SAMPLE] Chips'].id, quantity: 1 }], 'TELDA'));
      expect(e.hint).toBe('FORBIDDEN');
      const au = await pool.query(`select action from audit_logs where entity_id = $1 and action in ('user_updated','cashier_section_assigned')`, [bazaar2]);
      expect(au.rows.map((r) => r.action)).toContain('cashier_section_assigned');
    });

    it('admin cannot demote or deactivate themselves', async () => {
      const e = await errOf(rpc(pool, admin, 'admin_update_user', [admin, 'Admin', 'cashier', 'BAZAAR', true]));
      expect(e.message).toMatch(/own admin account/);
    });

    it('activating a dashboard-created user requires a section for cashiers', async () => {
      const e = await errOf(rpc(pool, admin, 'admin_update_user', [pending, 'New', 'cashier', null, true]));
      expect(e.message).toMatch(/section/);
      await rpc(pool, admin, 'admin_update_user', [pending, 'New', 'cashier', 'BAZAAR', true]);
      expect((await as(pool, pending, 'select distinct section_code from products')).length).toBe(1);
    });

    it('audit log recorded the critical actions', async () => {
      const { rows } = await pool.query('select distinct action from audit_logs');
      const actions = rows.map((r) => r.action);
      for (const a of [
        'login', 'sale_completed', 'void_requested', 'void_approved', 'void_rejected', 'product_created',
        'price_changed', 'cost_changed', 'stock_adjusted', 'user_updated', 'cashier_section_assigned',
        'cash_handover_recorded', 'cash_handover_corrected', 'settings_changed', 'products_imported',
      ]) {
        expect(actions, a).toContain(a);
      }
    });

    it('ledger rows are immutable even for the database owner', async () => {
      const e1 = await errOf(pool.query('update transaction_items set unit_price = 0'));
      expect(e1.message).toMatch(/append-only/);
      const e2 = await errOf(pool.query('delete from audit_logs'));
      expect(e2.message).toMatch(/append-only/);
      const e3 = await errOf(pool.query('update transactions set total = 0'));
      expect(e3.message).toMatch(/Only a completed transaction|immutable/);
      const e4 = await errOf(pool.query('delete from transactions'));
      expect(e4.message).toMatch(/cannot be deleted/);
      const e5 = await errOf(pool.query('truncate audit_logs'));
      expect(e5.message).toMatch(/append-only/);
    });

    it('clear_test_data script wipes sales, restores stock and keeps the audit log', async () => {
      const { readFileSync } = await import('node:fs');
      const auditBefore = (await pool.query('select count(*)::int n from audit_logs')).rows[0].n;
      const expected = await pool.query(
        `select p.id, p.stock - coalesce(sum(m.quantity_change) filter (where m.movement_type in ('sale','void_restore')), 0) as s
           from products p left join stock_movements m on m.product_id = p.id group by p.id`,
      );
      await pool.query(readFileSync(new URL('../../supabase/scripts/clear_test_data.sql', import.meta.url), 'utf8'));
      expect((await pool.query('select count(*)::int n from transactions')).rows[0].n).toBe(0);
      for (const r of expected.rows) expect(await stockOf(r.id)).toBe(Number(r.s));
      expect((await pool.query('select count(*)::int n from audit_logs')).rows[0].n).toBe(auditBefore + 1);
      // triggers are back on
      const e = await errOf(pool.query('delete from audit_logs'));
      expect(e.message).toMatch(/append-only/);
      // numbering restarts
      const r = await checkout(bazaar, [{ product_id: product['Keychains'].id, quantity: 1 }], 'TELDA');
      expect(r.txn_no).toBe('BZR-000001');
    });
  });
});
