import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createUser, as, rpc } from './db-helpers.js';

// Shared by PostgreSQL tests and the embedded PostgreSQL smoke runner.
export async function checkStaffRoles(pool) {
  const checks = [];
  const ids = {};
  for (const role of ['admin', 'cashier', 'finance', 'product_manager', 'supplier']) {
    ids[role] = await createUser(pool, { email: `roles-${role}@test.local`, username: `roles-${role}`,
      role, section: role === 'cashier' ? 'BAZAAR' : null });
    const [profile] = await as(pool, ids[role], 'select role,active,section_code from profiles where id = $1', [ids[role]]);
    assert.equal(profile.role, role); assert.equal(profile.active, true);
    assert.equal(profile.section_code, role === 'cashier' ? 'BAZAAR' : null);
  }
  checks.push('All five roles provision active profiles');
  for (const section of ['BAZAAR', 'SNACKS']) {
    const category = await rpc(pool, ids.product_manager, 'admin_save_category', [null, section, `Role category ${section}`, 1, true]);
    await rpc(pool, ids.product_manager, 'admin_save_category', [category, section, `Renamed ${section}`, 2, true]);
    await rpc(pool, ids.product_manager, 'admin_save_category', [category, section, `Renamed ${section}`, 2, false]);
    const [inactive] = await as(pool, ids.product_manager, 'select name, active, sort_order from categories where id = $1', [category]);
    assert.equal(inactive.name, `Renamed ${section}`); assert.equal(inactive.active, false); assert.equal(inactive.sort_order, 2);
    await rpc(pool, ids.product_manager, 'admin_save_category', [category, section, `Renamed ${section}`, 2, true]);
    const [active] = await as(pool, ids.product_manager, 'select active from categories where id = $1', [category]);
    assert.equal(active.active, true);
    for (const role of ['finance', 'supplier', 'cashier']) {
      await assert.rejects(rpc(pool, ids[role], 'admin_save_category', [category, section, 'Forbidden', 2, false]), /cannot perform/i);
    }
  }
  checks.push('Product manager can edit, deactivate and reactivate categories in both sections');
  const otherSupplier = await createUser(pool, { email: 'other-supplier@test.local', username: 'other-supplier', role: 'supplier' });
  const product = await rpc(pool, ids.product_manager, 'admin_save_product', [JSON.stringify({
    section_code: 'BAZAAR', name: 'Role test item', price: 15, cost: 8, starting_stock: 10,
  })]);
  await rpc(pool, ids.product_manager, 'admin_adjust_stock', [product, 'add', 1, 'New stock']);
  checks.push('Product manager can create products and adjust stock');
  for (const role of ['finance', 'supplier', 'cashier']) {
    await assert.rejects(rpc(pool, ids[role], 'admin_adjust_stock', [product, 'add', 1, 'Forbidden']), /cannot perform|admin/i);
    await assert.rejects(rpc(pool, ids[role], 'admin_save_product', [JSON.stringify({ section_code: 'BAZAAR', name: 'Forbidden', price: 1 })]), /cannot perform|admin/i);
  }
  checks.push('Finance, supplier and cashier cannot edit inventory');
  for (const role of ['finance', 'supplier', 'product_manager']) {
    await assert.rejects(rpc(pool, ids[role], 'pos_checkout', [randomUUID(), JSON.stringify([{product_id: product, quantity: 1}]), 'TELDA', null, 15, 'BAZAAR']), /cannot perform/i);
    await assert.rejects(rpc(pool, ids[role], 'admin_update_settings', ['{}']), /admin/i);
    await assert.rejects(rpc(pool, ids[role], 'admin_update_user', [ids[role], role, 'admin', null, true]), /admin/i);
  }
  checks.push('New roles cannot sell, change settings, or promote accounts');
  await rpc(pool, ids.cashier, 'pos_checkout', [randomUUID(), JSON.stringify([{product_id: product, quantity: 1}]), 'TELDA', null, 15, null]);
  await rpc(pool, ids.admin, 'pos_checkout', [randomUUID(), JSON.stringify([{product_id: product, quantity: 1}]), 'INSTAPAY', null, 15, 'BAZAAR']);
  const report = await rpc(pool, ids.finance, 'admin_sales_report', ['2000-01-01', '2099-01-01', null]);
  assert.equal(Number(report.totals.revenue), 30);
  assert.equal(Number(report.totals.cogs), 16);
  await rpc(pool, ids.finance, 'admin_record_handover', ['2026-11-07', 'BAZAAR', ids.cashier, 0, 'Finance test']);
  for (const role of ['supplier', 'product_manager']) await assert.rejects(rpc(pool, ids[role], 'admin_sales_report', ['2000-01-01', '2099-01-01', null]), /cannot perform/i);
  checks.push('Existing sellers work; finance can report and reconcile cash');
  for (const table of ['transactions', 'transaction_items', 'product_costs', 'cash_handovers', 'products']) {
    assert.equal((await as(pool, ids.supplier, `select * from ${table}`)).length, 0);
  }
  assert.equal((await as(pool, ids.product_manager, 'select * from transactions')).length, 0);
  checks.push('Supplier and product manager cannot read restricted tables');
  const key = randomUUID();
  const orderArgs = [key, ids.supplier, 'Weekly list', JSON.stringify([{ product_id: product, quantity: 5 }])];
  assert.equal(await rpc(pool, ids.product_manager, 'create_supplier_order', orderArgs), key);
  assert.equal(await rpc(pool, ids.product_manager, 'create_supplier_order', orderArgs), key);
  const [item] = await as(pool, ids.supplier, 'select * from supplier_order_items');
  assert.equal(item.quantity, 5);
  assert.equal((await as(pool, otherSupplier, 'select * from supplier_orders')).length, 0);
  assert.equal((await as(pool, otherSupplier, 'select * from supplier_order_items')).length, 0);
  assert.equal((await as(pool, ids.cashier, 'select * from supplier_orders')).length, 0);
  await assert.rejects(rpc(pool, otherSupplier, 'supplier_confirm_purchase', [item.id, 3]), /assigned/i);
  await assert.rejects(rpc(pool, otherSupplier, 'supplier_confirm_delivery', [item.id, 3]), /assigned/i);
  await assert.rejects(as(pool, ids.supplier, 'update supplier_order_items set received = quantity'), /permission/i);
  checks.push('Assigned-list isolation and duplicate-list prevention');
  const stock = async () => Number((await pool.query('select stock from products where id = $1', [product])).rows[0].stock);
  const before = await stock();
  await assert.rejects(rpc(pool, ids.supplier, 'supplier_set_available', [item.id, true]), /permission/i);
  for (const receiver of [ids.admin, ids.product_manager]) {
    await assert.rejects(rpc(pool, receiver, 'receive_supplier_item', [randomUUID(), item.id, 1]), /supplier must confirm/i);
    await assert.rejects(rpc(pool, receiver, 'supplier_confirm_purchase', [item.id, 3]), /cannot perform/i);
    await assert.rejects(rpc(pool, receiver, 'supplier_confirm_delivery', [item.id, 3]), /cannot perform/i);
  }
  for (const role of ['finance','cashier']) {
    await assert.rejects(rpc(pool, ids[role], 'supplier_confirm_purchase', [item.id, 3]), /cannot perform/i);
    await assert.rejects(rpc(pool, ids[role], 'supplier_confirm_delivery', [item.id, 3]), /cannot perform/i);
  }
  await assert.rejects(rpc(pool, ids.supplier, '_supplier_confirm_quantity', [item.id, 3, 'purchase']), /permission/i);
  await assert.rejects(rpc(pool, ids.supplier, 'supplier_confirm_purchase', [item.id, 1.5]), /invalid input|integer/i);
  await assert.rejects(rpc(pool, ids.supplier, 'supplier_confirm_delivery', [item.id, 1]), /Confirm how many/i);
  await assert.rejects(rpc(pool, ids.supplier, 'supplier_confirm_purchase', [item.id, 6]), /requested quantity/i);
  await assert.rejects(rpc(pool, ids.supplier, 'supplier_confirm_purchase', [item.id, 0]), /positive whole/i);
  await rpc(pool, ids.supplier, 'supplier_confirm_purchase', [item.id, 3]);
  await rpc(pool, ids.supplier, 'supplier_confirm_purchase', [item.id, 3]);
  await assert.rejects(rpc(pool, ids.supplier, 'supplier_confirm_purchase', [item.id, 2]), /cannot decrease/i);
  await assert.rejects(rpc(pool, ids.product_manager, 'receive_supplier_item', [randomUUID(), item.id, 1]), /supplier must confirm/i);
  await assert.rejects(rpc(pool, ids.supplier, 'supplier_confirm_delivery', [item.id, 4]), /purchased total/i);
  await rpc(pool, ids.supplier, 'supplier_confirm_delivery', [item.id, 2]);
  await rpc(pool, ids.supplier, 'supplier_confirm_delivery', [item.id, 2]);
  await assert.rejects(rpc(pool, ids.supplier, 'supplier_confirm_delivery', [item.id, 1]), /must not decrease/i);
  await assert.rejects(rpc(pool, ids.product_manager, 'receive_supplier_item', [randomUUID(), item.id, 3]), /supplier-confirmed delivery/i);
  assert.equal(await stock(), before);
  await assert.rejects(rpc(pool, ids.supplier, 'receive_supplier_item', [randomUUID(), item.id, 2]), /cannot perform/i);
  checks.push('Only the assigned supplier can confirm purchased and delivered quantities, without adding stock');
  const receiptKey = randomUUID();
  await rpc(pool, ids.product_manager, 'receive_supplier_item', [receiptKey, item.id, 2]);
  await rpc(pool, ids.product_manager, 'receive_supplier_item', [receiptKey, item.id, 2]);
  assert.equal(await stock(), before + 2);
  await assert.rejects(rpc(pool, ids.product_manager, 'receive_supplier_item', [receiptKey, item.id, 1]), /different receipt/i);
  await assert.rejects(rpc(pool, ids.product_manager, 'receive_supplier_item', [randomUUID(), item.id, 4]), /supplier-confirmed delivery/i);
  assert.equal(await stock(), before + 2);
  await assert.rejects(rpc(pool, ids.admin, 'receive_supplier_item', [randomUUID(), item.id, 1]), /supplier-confirmed delivery/i);
  await rpc(pool, ids.supplier, 'supplier_confirm_purchase', [item.id, 5]);
  await assert.rejects(rpc(pool, ids.admin, 'receive_supplier_item', [randomUUID(), item.id, 1]), /supplier-confirmed delivery/i);
  await rpc(pool, ids.supplier, 'supplier_confirm_delivery', [item.id, 5]);
  await rpc(pool, ids.admin, 'receive_supplier_item', [randomUUID(), item.id, 3]);
  assert.equal(await stock(), before + 5);
  const [finalItem] = await as(pool, ids.supplier, 'select purchased, delivered, received from supplier_order_items where id = $1', [item.id]);
  assert.deepEqual(finalItem, {purchased:5, delivered:5, received:5});
  await assert.rejects(as(pool, ids.supplier, 'update supplier_order_items set delivered = 100'), /permission/i);
  await assert.rejects(pool.query('update supplier_order_items set delivered = 0 where id = $1', [item.id]), /check constraint/i);
  checks.push('Partial receipts, safe retries, overreceipt and completed-item checks');
  const receipts = await as(pool, ids.admin, 'select * from supplier_receipts');
  assert.equal(receipts.length, 2);
  assert.equal((await as(pool, ids.supplier, 'select * from supplier_receipts')).length, 0);
  await assert.rejects(pool.query('delete from supplier_receipts'), /append-only/i);
  const audit = await pool.query("select * from audit_logs where action = 'supplier_goods_received'");
  assert.equal(audit.rows.length, 2);
  const confirmations = await pool.query("select action, count(*)::int n from audit_logs where action in ('supplier_purchase_confirmed','supplier_delivery_confirmed') group by action");
  assert.deepEqual(Object.fromEntries(confirmations.rows.map(r=>[r.action,r.n])), {supplier_purchase_confirmed:2,supplier_delivery_confirmed:2});
  checks.push('Receipts are immutable and exactly-once actions are audited');
  await rpc(pool, ids.admin, 'admin_update_user', [ids.supplier, 'Supplier', 'supplier', null, false]);
  assert.equal((await as(pool, ids.supplier, 'select * from supplier_orders')).length, 0);
  await assert.rejects(rpc(pool, ids.supplier, 'supplier_confirm_purchase', [item.id, 5]), /inactive/i);
  checks.push('Deactivation immediately revokes supplier access');
  return checks;
}
