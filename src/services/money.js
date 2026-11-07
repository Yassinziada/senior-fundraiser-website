import { supabase } from '../lib/supabase.js';
import { rpc, run } from './api.js';
export const moneySummary = () => rpc('money_summary');
export const moneyStarted = async () => (await run(supabase.from('money_start').select('started_at').eq('id', 1)))?.[0] ?? null;
export const moneyHistory = () => run(supabase.from('money_ledger').select('*').order('id', { ascending: false }).limit(100));
export const submitMoney = (action) => rpc(action.fn, action.args);
export const stockMoneyArgs = ({ key, product, mode, quantity, reason, unitCost, account, noSpend, item = null }) => ({
  p_key: key, p_product: product, p_mode: mode, p_quantity: quantity, p_reason: reason,
  p_unit_cost: noSpend ? null : unitCost, p_account: noSpend ? null : account, p_no_spend: noSpend, p_item: item,
});
