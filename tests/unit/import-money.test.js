import { it, expect } from 'vitest';
import { parseProductsFile } from '../../src/utils/legacyImport.js';
it('flags malformed or missing purchase costs so paid stock cannot be imported as free',()=>{
 const parsed=parseProductsFile('name,price,cost,stock\nMissing,30,,2\nBad,30,abc,2\nNegative,30,-1,2\nDecimals,30,1.234,2\nValid,30,20.50,2\nFree,30,0,2');
 expect(parsed.rows.map(r=>r.purchase_cost_valid)).toEqual([false,false,false,false,true,true]);
});
it('recognizes original backup costs as integer piasters',()=>{
 const parsed=parseProductsFile(JSON.stringify({app:'bazaar-pos',data:{products:[{name:'Water',price:3000,cost:2050,stock:2}]}}));
 expect(parsed.rows[0].cost).toBe(20.5);expect(parsed.rows[0].purchase_cost_valid).toBe(true);
});
