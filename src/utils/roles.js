export const ROLE_LABELS = {
  admin: 'Admin', cashier: 'Cashier', finance: 'Finance',
  product_manager: 'Product Manager', supplier: 'Supplier',
};
export const roleHome = (role) => role === 'cashier' ? '/pos' : role === 'supplier' ? '/supplier' : '/admin';
export const canOpenPage = (role, page) => role === 'admin' || ({
  finance: ['', 'reports', 'cash'],
  product_manager: ['products', 'categories', 'stock', 'import', 'suppliers'],
}[role] ?? []).includes(page);
export const firstStaffPage = (role) => role === 'product_manager' ? '/admin/products' : '/admin';
