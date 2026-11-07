import { describe, it, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { TEST_URL, createTestDatabase } from './db-helpers.js';
import { checkSupplierUpgrade } from './supplier-upgrade.cases.js';

(TEST_URL ? describe : describe.skip)('Supplier quantity workflow upgrade', () => {
  let pool;
  beforeAll(async () => {
    pool = await createTestDatabase('pos_supplier_upgrade_test', {through:'20261107000003_supplier_orders.sql'});
  }, 60000);
  afterAll(async () => { await pool?.end(); });
  it('preserves historical receipts and enforces new supplier confirmations', async () => {
    await checkSupplierUpgrade(pool, () => pool.query(readFileSync(new URL('../../supabase/migrations/20261107000004_supplier_fulfillment.sql', import.meta.url), 'utf8')));
  }, 60000);
});
