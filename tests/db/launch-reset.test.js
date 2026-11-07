import { describe,it,beforeAll,afterAll,expect } from 'vitest';
import {readFileSync} from 'node:fs';
import { randomUUID } from 'node:crypto';
import {TEST_URL,createTestDatabase,createUser,rpc} from './db-helpers.js';
const roleSQL=readFileSync('supabase/scripts/launch_01_roles.sql','utf8');
const launchSQL=readFileSync('supabase/scripts/launch_02_upgrade_reset_keep_catalogue.sql','utf8');
(TEST_URL?describe:describe.skip)('Live launch catalogue-preserving reset',()=>{
 let pool;
 beforeAll(async()=>{pool=await createTestDatabase('pos_launch_reset_test',{through:'20260928000004_storage_realtime.sql'});},60000);
 afterAll(async()=>{await pool?.end();});
 it('refuses to erase data when the preserved Admin is missing',async()=>{
  const before=Number((await pool.query('select count(*) n from products')).rows[0].n);
  const c=await pool.connect();
  try {await expect(c.query(launchSQL)).rejects.toThrow(/Admin.*not found/);await c.query('rollback');}finally{c.release();}
  expect(Number((await pool.query('select count(*) n from products')).rows[0].n)).toBe(before);
 });
 it('upgrades old live schema, keeps catalogue and Admin, clears event data, and refuses repeated destruction',async()=>{
  const admin=await createUser(pool,{email:'yassinziada@gmail.com',username:'launch-admin',role:'admin'});
  const cashier=await createUser(pool,{email:'launch-cashier@test.local',username:'launch-cashier',role:'cashier',section:'BAZAAR'});
  const product=await rpc(pool,admin,'admin_save_product',[JSON.stringify({section_code:'BAZAAR',name:'Preserve water',price:30,cost:20,starting_stock:10,image_url:'https://example.com/water.jpg'})]);
  await rpc(pool,cashier,'pos_checkout',[randomUUID(),JSON.stringify([{product_id:product,quantity:1}]),'CASH',30,30,null]);
  const catalogue=(await pool.query('select id,name,price,image_url,category_id from products order by id')).rows;
  const costs=(await pool.query('select product_id,cost from product_costs order by product_id')).rows;
  const categories=(await pool.query('select * from categories order by id')).rows;
  await pool.query(roleSQL);
  // Simulate an unexpected managed-service FK: the entire upgrade/reset must roll back.
  await pool.query('create table public.launch_test_blocker(uid uuid references auth.users(id))');
  await pool.query('insert into public.launch_test_blocker values($1)',[cashier]);
  const failed=await pool.connect();
  try {await expect(failed.query(launchSQL)).rejects.toThrow(/foreign key/);await failed.query('rollback');}finally{failed.release();}
  expect((await pool.query("select to_regclass('public.money_start') t")).rows[0].t).toBe(null);
  expect((await pool.query('select stock from products where id=$1',[product])).rows[0].stock).toBe(9);
  expect(Number((await pool.query('select count(*) n from transactions')).rows[0].n)).toBe(1);
  expect((await pool.query("select tgenabled from pg_trigger where tgname='transactions_guard'")).rows[0].tgenabled).toBe('O');
  await pool.query('drop table public.launch_test_blocker');
  const c=await pool.connect();
  try {await c.query(launchSQL);} finally {c.release();}
  expect((await pool.query('select id,name,price,image_url,category_id from products order by id')).rows).toEqual(catalogue);
  expect((await pool.query('select product_id,cost from product_costs order by product_id')).rows).toEqual(costs);
  expect((await pool.query('select * from categories order by id')).rows).toEqual(categories);
  expect((await pool.query('select id from auth.users')).rows).toEqual([{id:admin}]);
  expect((await pool.query('select id,role,active from profiles')).rows).toEqual([{id:admin,role:'admin',active:true}]);
  for(const table of ['transactions','transaction_items','void_requests','cash_handovers','stock_movements','supplier_orders','supplier_order_items','supplier_receipts','money_ledger','money_actions','money_start'])
   expect(Number((await pool.query(`select count(*) n from ${table}`)).rows[0].n)).toBe(0);
  expect(Number((await pool.query('select count(*) n from products where stock<>0 or starting_stock<>0')).rows[0].n)).toBe(0);
  expect((await pool.query("select count(*)::int n from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace='public'::regnamespace and t.tgenabled='D'")).rows[0].n).toBe(0);
  await rpc(pool,admin,'money_open',[randomUUID(),1000,0,0]);
  const retry=await pool.connect();
  try {await expect(retry.query(launchSQL)).rejects.toThrow(/already ran/);await retry.query('rollback');}finally{retry.release();}
  expect(Number((await rpc(pool,admin,'money_summary')).total)).toBe(1000);
  await expect(pool.query('delete from audit_logs')).rejects.toThrow(/append-only/);
 },60000);
});
