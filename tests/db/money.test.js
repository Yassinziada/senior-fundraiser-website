import { describe, it, beforeAll, afterAll } from 'vitest';
import { TEST_URL, createTestDatabase } from './db-helpers.js';
import { checkMoney } from './money.cases.js';
(TEST_URL ? describe : describe.skip)('Fundraiser money', () => {
 let pool;
 beforeAll(async()=>{pool=await createTestDatabase('pos_money_test');},60000);
 afterAll(async()=>{await pool?.end();});
 it('tracks stock payments, sales, profit and balances atomically',async()=>{await checkMoney(pool);},60000);
});
