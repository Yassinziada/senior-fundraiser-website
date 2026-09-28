// Cashier-side data access. Everything here is authorised by the database:
// RLS limits products/categories to the cashier's own section, and the RPCs
// check the caller's role and section themselves.
import { supabase } from '../lib/supabase.js';
import { rpc, run } from './api.js';

// NOTE: products has no cost column; cost lives in an admin-only table.
const POS_PRODUCT_COLUMNS = 'id, name, section_code, category_id, price, image_url, track_stock, stock, min_stock, active';

export function fetchPosProducts(sectionCode) {
  let q = supabase.from('products').select(POS_PRODUCT_COLUMNS).eq('active', true).order('name');
  if (sectionCode) q = q.eq('section_code', sectionCode);
  return run(q);
}

export function fetchPosCategories(sectionCode) {
  let q = supabase.from('categories').select('id, name, section_code, sort_order').eq('active', true).order('sort_order').order('name');
  if (sectionCode) q = q.eq('section_code', sectionCode);
  return run(q);
}

/**
 * Complete a sale. The idempotency key MUST be reused for retries of the same
 * sale so a slow network or double click can never create two sales.
 */
export function checkout({ idempotencyKey, items, paymentMethod, amountReceived, expectedTotal, section }) {
  return rpc(
    'pos_checkout',
    {
      p_idempotency_key: idempotencyKey,
      p_items: items,
      p_payment_method: paymentMethod,
      p_amount_received: paymentMethod === 'CASH' ? amountReceived : null,
      p_expected_total: expectedTotal,
      p_section: section ?? null,
    },
    { timeoutMs: 25_000 },
  );
}

export const checkoutStatus = (idempotencyKey) => rpc('pos_checkout_status', { p_idempotency_key: idempotencyKey });
export const myTransactions = () => rpc('pos_my_transactions', { p_limit: 200 });
export const requestVoid = (transactionId, reason) =>
  rpc('pos_request_void', { p_transaction_id: transactionId, p_reason: reason });
