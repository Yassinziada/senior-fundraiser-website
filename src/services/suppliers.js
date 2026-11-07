import { supabase } from '../lib/supabase.js';
import { rpc, run } from './api.js';

export const supplierOrders = () => run(supabase.from('supplier_orders')
  .select('id,title,supplier_id,created_at,items:supplier_order_items(id,product_id,product_name,quantity,purchased,delivered,purchased_at,delivered_at,received)')
  .order('created_at', { ascending: false }));
export const supplierAccounts = () => run(supabase.from('profiles')
  .select('id,full_name,username').eq('role', 'supplier').eq('active', true).order('username'));
export const createSupplierOrder = ({ key, supplier, title, items }) => rpc('create_supplier_order', {
  p_id: key, p_supplier: supplier, p_title: title, p_items: items,
});
export const confirmSupplierPurchase = ({ item, quantity }) => rpc('supplier_confirm_purchase', {
  p_item: item, p_quantity: quantity,
});
export const confirmSupplierDelivery = ({ item, quantity }) => rpc('supplier_confirm_delivery', {
  p_item: item, p_quantity: quantity,
});
export const receiveSupplierItem = ({ key, item, product, quantity, unitCost, account }) => rpc('money_stock', {
  p_key: key, p_item: item, p_product: product, p_mode: 'add', p_quantity: quantity,
  p_reason: 'Approved supplier delivery', p_unit_cost: unitCost, p_account: account, p_no_spend: false,
});
