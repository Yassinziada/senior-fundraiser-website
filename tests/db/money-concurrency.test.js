import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TEST_URL, createTestDatabase, createUser, rpc, as } from './db-helpers.js';
(TEST_URL ? describe : describe.skip)('Concurrent money actions', () => {
 let pool,admin,manager,cashier,product;
 beforeAll(async()=>{
  pool=await createTestDatabase('pos_money_race_test');
  admin=await createUser(pool,{email:'money-race-admin@test.local',username:'money-race-admin',role:'admin'});
  manager=await createUser(pool,{email:'money-race-manager@test.local',username:'money-race-manager',role:'product_manager'});
  cashier=await createUser(pool,{email:'money-race-cashier@test.local',username:'money-race-cashier',role:'cashier',section:'BAZAAR'});
  product=await rpc(pool,admin,'admin_save_product',[JSON.stringify({name:'Concurrent money item',section_code:'BAZAAR',price:10,cost:5,starting_stock:10})]);
  await rpc(pool,admin,'money_open',[randomUUID(),100,0,0]);
 },60000);
 afterAll(async()=>{await pool?.end();});
 it('allows only one of two expenses that together exceed the balance',async()=>{
  const results=await Promise.allSettled([1,2].map(n=>rpc(pool,admin,'money_record',[randomUUID(),'expense','CASH',60,`Transport ${n}`,null])));
  expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  expect(Number((await rpc(pool,admin,'money_summary')).total)).toBe(40);
 });
 it('parallel retry of a stock receipt charges and adds stock once',async()=>{
  const args=[randomUUID(),product,'add',2,'Concurrent stock',5,'CASH',false,null];
  await Promise.all(Array.from({length:5},()=>rpc(pool,manager,'money_stock',args)));
  expect(Number((await rpc(pool,admin,'money_summary')).total)).toBe(30);
  expect((await as(pool,admin,'select stock from products where id=$1',[product]))[0].stock).toBe(12);
 });
 it('checkout, supplier-independent stock purchase and refund do not deadlock or double count',async()=>{
  const tx=await rpc(pool,cashier,'pos_checkout',[randomUUID(),JSON.stringify([{product_id:product,quantity:1}]),'CASH',10,10,null]);
  const results=await Promise.allSettled([
   rpc(pool,admin,'admin_void_transaction',[tx.id||tx.transaction_id,'Refund return']),
   rpc(pool,manager,'money_stock',[randomUUID(),product,'add',1,'Concurrent receipt',5,'CASH',false,null]),
   rpc(pool,cashier,'pos_checkout',[randomUUID(),JSON.stringify([{product_id:product,quantity:1}]),'TELDA',null,10,null])
  ]);
  expect(results.every(x=>x.status==='fulfilled'),JSON.stringify(results)).toBe(true);
  const s=await rpc(pool,admin,'money_summary');
  expect(Number(s.total)).toBe(35);expect(Number(s.sales)).toBe(10);
 },15000);
});
