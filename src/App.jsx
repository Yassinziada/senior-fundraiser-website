import { Navigate, Route, Routes } from 'react-router-dom';
import { configError } from './lib/supabase.js';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { SettingsProvider } from './context/SettingsContext.jsx';
import { ToastProvider } from './context/ToastContext.jsx';
import { Spinner } from './components/ui.jsx';
import LoginPage from './pages/LoginPage.jsx';
import { ConfigErrorPage, InactivePage, LoadErrorPage } from './pages/StatusPages.jsx';
import CashierLayout from './pages/pos/CashierLayout.jsx';
import AdminLayout from './pages/admin/AdminLayout.jsx';
import SupplierLayout from './pages/supplier/SupplierLayout.jsx';
import { roleHome, firstStaffPage } from './utils/roles.js';

export default function App() {
  if (configError) return <ConfigErrorPage message={configError} />;
  return (
    <ToastProvider>
      <AuthProvider>
        <SettingsProvider>
          <AppRoutes />
        </SettingsProvider>
      </AuthProvider>
    </ToastProvider>
  );
}

/**
 * Route guards. These only decide which SCREENS are shown. The real security
 * boundary is the database (RLS + role-checking functions): a cashier who
 * forces their way to /admin just gets empty tables and "forbidden" errors.
 */
function AppRoutes() {
  const { status, profile, error } = useAuth();
  if (status === 'loading') return <Spinner label="Starting…" />;
  if (status === 'error') return <LoadErrorPage error={error} />;
  if (status === 'signed-out') {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  if (status === 'inactive') return <InactivePage />;

  const home = ['admin', 'finance', 'product_manager'].includes(profile.role) ? firstStaffPage(profile.role) : roleHome(profile.role);
  return (
    <Routes>
      <Route path="/pos/*" element={profile.role === 'cashier' ? <CashierLayout /> : <Navigate to={profile.role === 'admin' ? '/admin/sell' : home} replace />} />
      <Route path="/admin/*" element={['admin', 'finance', 'product_manager'].includes(profile.role) ? <AdminLayout /> : <Navigate to={home} replace />} />
      <Route path="/supplier/*" element={profile.role === 'supplier' ? <SupplierLayout /> : <Navigate to={home} replace />} />
      <Route path="*" element={<Navigate to={home} replace />} />
    </Routes>
  );
}
