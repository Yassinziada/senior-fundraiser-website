import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createUser, as, rpc } from './db-helpers.js';

export async function checkSupplierUpgrade(pool, applyUpgrade) {
  const manager = await createUser(pool, { email: 'upgrade-manager@test.local', username: 'upgrade-manager', role: 'product_manager' });
  const supplier = await createUser(pool, { email: 'upgrade-supplier@test.local', username: 'upgrade-supplier', role: 'supplier' });
  const product = await rpc(pool, manager, 'admin_save_product', [JSON.stringify({section_code:'BAZAAR', name:'Upgrade item', price:10, cost:5, starting_stock:10})]);
  await rpc(pool, manager, 'create_supplier_order', [randomUUID(), supplier, 'Existing list', JSON.stringify([{product_id:product, quantity:5}])]);
  const [item] = await as(pool, supplier, 'select * from supplier_order_items');
  await rpc(pool, supplier, 'supplier_set_available', [item.id, true]);
  const oldKey = randomUUID();
  await rpc(pool, manager, 'receive_supplier_item', [oldKey, item.id, 2]);
  const stock = async () => Number((await pool.query('select stock from products where id = $1', [product])).rows[0].stock);
  assert.equal(await stock(), 12);

  await applyUpgrade();
  const [upgraded] = await as(pool, supplier, 'select purchased,delivered,received,purchased_at,delivered_at,available from supplier_order_items where id = $1', [item.id]);
  assert.deepEqual(upgraded, {purchased:2,delivered:2,received:2,purchased_at:null,delivered_at:null,available:true});
  assert.equal(await stock(), 12);
  assert.equal((await as(pool, manager, 'select * from supplier_receipts')).length, 1);
  await assert.rejects(rpc(pool, supplier, 'supplier_set_available', [item.id, false]), /permission/i);
  await assert.rejects(rpc(pool, manager, 'receive_supplier_item', [randomUUID(), item.id, 1]), /supplier must confirm/i);
  // A retry of a genuinely recorded old receipt remains safe and successful.
  await rpc(pool, manager, 'receive_supplier_item', [oldKey, item.id, 2]);
  assert.equal(await stock(), 12);
  await rpc(pool, supplier, 'supplier_confirm_purchase', [item.id, 3]);
  await assert.rejects(rpc(pool, manager, 'receive_supplier_item', [randomUUID(), item.id, 1]), /supplier must confirm/i);
  await rpc(pool, supplier, 'supplier_confirm_delivery', [item.id, 3]);
  await rpc(pool, manager, 'receive_supplier_item', [randomUUID(), item.id, 1]);
  assert.equal(await stock(), 13);
  const [final] = await as(pool, supplier, 'select purchased,delivered,received from supplier_order_items where id = $1', [item.id]);
  assert.deepEqual(final, {purchased:3,delivered:3,received:3});
  return ['Existing stock/receipts/availability history preserved; new receipt requires explicit supplier purchase and delivery'];
}
