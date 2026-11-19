import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it, beforeAll, afterAll } from 'vitest';
import { TEST_URL, createTestDatabase, createUser, as, rpc } from './db-helpers.js';

(TEST_URL ? describe : describe.skip)('Published supplier lists', () => {
  let pool;
  beforeAll(async () => { pool = await createTestDatabase('pos_supplier_edits_test'); }, 60000);
  afterAll(async () => { await pool?.end(); });

  it('lets both managers add and remove products and preserves purchases', async () => {
    const ids = {};
    for (const role of ['admin', 'product_manager', 'supplier', 'cashier', 'finance']) {
      ids[role] = await createUser(pool, {
        role, email: `list-${role}@test.local`, username: `list-${role}`,
        section: role === 'cashier' ? 'BAZAAR' : null,
      });
    }
    const product = await rpc(pool, ids.product_manager, 'admin_save_product', [JSON.stringify({
      section_code: 'BAZAAR', name: 'Published list product', price: 5, cost: 2, starting_stock: 0,
    })]);
    const key = randomUUID();
    await rpc(pool, ids.product_manager, 'create_supplier_order', [
      key, ids.supplier, 'Published list', JSON.stringify([{ product_id: product, quantity: 5 }]),
    ]);
    const [item] = await as(pool, ids.supplier, 'select id from supplier_order_items');
    const extraProduct = await rpc(pool, ids.product_manager, 'admin_save_product', [JSON.stringify({
      section_code: 'BAZAAR', name: 'Published list addition', price: 5, cost: 2, starting_stock: 0,
    })]);
    const addition = [randomUUID(), key, extraProduct, 4];
    for (const role of ['supplier', 'cashier', 'finance']) {
      await assert.rejects(rpc(pool, ids[role], 'add_supplier_order_item', addition), /cannot perform/i);
      await assert.rejects(rpc(pool, ids[role], 'remove_supplier_order_item', [key, item.id]), /cannot perform/i);
    }
    await rpc(pool, ids.admin, 'add_supplier_order_item', addition);
    await rpc(pool, ids.admin, 'add_supplier_order_item', addition);
    await assert.rejects(rpc(pool, ids.product_manager, 'add_supplier_order_item', [randomUUID(), key, extraProduct, 4]), /already on the list/i);
    const [added] = await as(pool, ids.supplier, 'select id, quantity from supplier_order_items where product_id = $1', [extraProduct]);
    assert.equal(added.quantity, 4);
    await rpc(pool, ids.product_manager, 'remove_supplier_order_item', [randomUUID(), added.id]);
    assert.equal((await as(pool, ids.supplier, 'select id from supplier_order_items where id = $1', [added.id])).length, 1);
    await rpc(pool, ids.product_manager, 'remove_supplier_order_item', [key, added.id]);
    await rpc(pool, ids.product_manager, 'remove_supplier_order_item', [key, added.id]);
    await rpc(pool, ids.admin, 'add_supplier_order_item', addition);
    assert.deepEqual(await as(pool, ids.supplier, 'select id from supplier_order_items'), [{ id: item.id }]);
    await rpc(pool, ids.product_manager, 'add_supplier_order_item', [randomUUID(), key, extraProduct, 4]);
    const [readded] = await as(pool, ids.supplier, 'select id from supplier_order_items where product_id = $1', [extraProduct]);
    await rpc(pool, ids.admin, 'remove_supplier_order_item', [key, readded.id]);
    await rpc(pool, ids.supplier, 'supplier_confirm_purchase', [item.id, 3]);
    await assert.rejects(rpc(pool, ids.admin, 'remove_supplier_order_item', [key, item.id]), /confirmed purchase/i);
    assert.deepEqual(await as(pool, ids.supplier, 'select id, purchased from supplier_order_items'), [{ id: item.id, purchased: 3 }]);
  }, 60000);
});
