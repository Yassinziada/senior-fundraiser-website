// Admin data access. These calls FAIL for cashiers at the database level
// (RLS returns no rows; admin_* functions raise FORBIDDEN) — hiding the admin
// screens in the UI is only a convenience, not the security boundary.
import { supabase } from '../lib/supabase.js';
import { rpc, run, adminUsersFunction } from './api.js';

// ---- products & categories ----
export const productsOverview = (section) => rpc('admin_products_overview', { p_section: section ?? null });
export const saveProduct = (p) => rpc('admin_save_product', { p });
export const setProductActive = (id, active) => rpc('admin_set_product_active', { p_product_id: id, p_active: active });
export const adjustStock = (productId, mode, quantity, reason) =>
  rpc('admin_adjust_stock', { p_product_id: productId, p_mode: mode, p_quantity: quantity, p_reason: reason });
export const importProducts = (rows) => rpc('admin_import_products', { p_rows: rows }, { timeoutMs: 60_000 });

export function fetchCategories(section) {
  let q = supabase.from('categories').select('*').order('section_code').order('sort_order').order('name');
  if (section) q = q.eq('section_code', section);
  return run(q);
}
export const saveCategory = ({ id = null, section_code, name, sort_order = 0, active = true }) =>
  rpc('admin_save_category', { p_id: id, p_section: section_code, p_name: name, p_sort_order: sort_order, p_active: active });

export async function uploadProductImage(blob, ext = 'jpg') {
  const path = `products/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from('product-images').upload(path, blob, {
    cacheControl: '31536000',
    contentType: blob.type || 'image/jpeg',
    upsert: false,
  });
  if (error) throw new Error(`Image upload failed: ${error.message}`);
  return supabase.storage.from('product-images').getPublicUrl(path).data.publicUrl;
}

// ---- sales & voids ----
export const TXN_SELECT =
  'id, txn_no, section_code, cashier_id, created_at, business_date, item_count, total, total_cost, payment_method, amount_received, change_given, status, voided_at, voided_by, void_reason, cashier:profiles!transactions_cashier_id_fkey(full_name, username)';

export function fetchTransactions({ from, to, section, cashierId, method, status, search, page = 0, pageSize = 50 }) {
  let q = supabase
    .from('transactions')
    .select(`${TXN_SELECT}, void_requests(id, status, reason, requested_at, decided_at, decision_note)`, { count: 'exact' })
    .order('created_at', { ascending: false });
  if (from) q = q.gte('business_date', from);
  if (to) q = q.lte('business_date', to);
  if (section) q = q.eq('section_code', section);
  if (cashierId) q = q.eq('cashier_id', cashierId);
  if (method) q = q.eq('payment_method', method);
  if (status) q = q.eq('status', status);
  if (search) q = q.ilike('txn_no', `%${search.trim()}%`);
  q = q.range(page * pageSize, page * pageSize + pageSize - 1);
  return run(q);
}

export function fetchTransactionDetail(id) {
  return run(
    supabase
      .from('transactions')
      .select(
        `${TXN_SELECT}, items:transaction_items(*), void_requests(*, requester:profiles!void_requests_requested_by_fkey(full_name, username), decider:profiles!void_requests_decided_by_fkey(full_name, username)), voider:profiles!transactions_voided_by_fkey(full_name, username)`,
      )
      .eq('id', id)
      .single(),
  );
}

export function fetchVoidRequests(status) {
  let q = supabase
    .from('void_requests')
    .select(
      '*, requester:profiles!void_requests_requested_by_fkey(full_name, username), decider:profiles!void_requests_decided_by_fkey(full_name, username), txn:transactions(id, txn_no, total, payment_method, created_at, item_count, status, section_code)',
    )
    .order('requested_at', { ascending: false })
    .limit(300);
  if (status) q = q.eq('status', status);
  return run(q);
}
export const decideVoid = (requestId, approve, note) =>
  rpc('admin_decide_void', { p_request_id: requestId, p_approve: approve, p_note: note || null });
export const voidTransaction = (transactionId, reason) =>
  rpc('admin_void_transaction', { p_transaction_id: transactionId, p_reason: reason });

export async function pendingVoidCount() {
  const { count } = await run(supabase.from('void_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'));
  return count ?? 0;
}

// ---- reports ----
export const salesReport = (from, to, section) =>
  rpc('admin_sales_report', { p_from: from, p_to: to, p_section: section ?? null }, { timeoutMs: 45_000 });
export const inventorySummary = (section) => rpc('admin_inventory_summary', { p_section: section ?? null });

export function fetchStockMovements({ from, to, section, productId, type, limit = 1000 }) {
  let q = supabase
    .from('stock_movements')
    .select('*, product:products(name, section_code), txn:transactions(txn_no), by:profiles(full_name, username)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (from) q = q.gte('created_at', from);
  if (to) q = q.lt('created_at', to);
  if (section) q = q.eq('section_code', section);
  if (productId) q = q.eq('product_id', productId);
  if (type) q = q.eq('movement_type', type);
  return run(q);
}

// ---- cash handover ----
export const cashSummary = (date, section) => rpc('admin_cash_summary', { p_date: date, p_section: section ?? null });
export const recordHandover = (date, section, cashierId, actual, notes) =>
  rpc('admin_record_handover', { p_date: date, p_section: section, p_cashier_id: cashierId, p_actual_cash: actual, p_notes: notes || null });

export function fetchHandovers({ from, to, section, includeSuperseded = false }) {
  let q = supabase
    .from('cash_handovers')
    .select('*, cashier:profiles!cash_handovers_cashier_id_fkey(full_name, username), recorder:profiles!cash_handovers_recorded_by_fkey(full_name, username)')
    .order('business_date', { ascending: false })
    .order('recorded_at', { ascending: false });
  if (from) q = q.gte('business_date', from);
  if (to) q = q.lte('business_date', to);
  if (section) q = q.eq('section_code', section);
  if (!includeSuperseded) q = q.is('superseded_at', null);
  return run(q);
}

// ---- audit ----
export function fetchAudit({ from, to, action, section, actorId, search, page = 0, pageSize = 100 }) {
  let q = supabase.from('audit_logs').select('*', { count: 'exact' }).order('created_at', { ascending: false });
  if (from) q = q.gte('created_at', from);
  if (to) q = q.lt('created_at', to);
  if (action) q = q.eq('action', action);
  if (section) q = q.eq('section_code', section);
  if (actorId) q = q.eq('actor_id', actorId);
  if (search) q = q.or(`entity_id.ilike.%${search}%,actor_name.ilike.%${search}%,action.ilike.%${search}%`);
  return run(q.range(page * pageSize, page * pageSize + pageSize - 1));
}

// ---- users & settings ----
export const fetchProfiles = () => run(supabase.from('profiles').select('*').order('role').order('username'));
export const updateUser = ({ id, full_name, role, section_code, active }) =>
  rpc('admin_update_user', { p_user_id: id, p_full_name: full_name, p_role: role, p_section: section_code, p_active: active });
export const createUser = (payload) => adminUsersFunction({ action: 'create_user', ...payload });
export const resetCredentials = (userId, pin) => adminUsersFunction({ action: 'reset_credentials', user_id: userId, pin });
export const updateSettings = (p) => rpc('admin_update_settings', { p });
