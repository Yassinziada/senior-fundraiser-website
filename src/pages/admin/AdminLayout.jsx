import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { useSettings } from '../../context/SettingsContext.jsx';
import { useOnlineStatus } from '../../hooks/useOnlineStatus.js';
import { useRealtime } from '../../hooks/useRealtime.js';
import { pendingVoidCount } from '../../services/admin.js';
import ConnectionBanner from '../../components/ConnectionBanner.jsx';
import Dashboard from './Dashboard.jsx';
import MoneyPage from './MoneyPage.jsx';
import SellPage from './SellPage.jsx';
import SalesPage from './SalesPage.jsx';
import VoidsPage from './VoidsPage.jsx';
import ProductsPage from './ProductsPage.jsx';
import CategoriesPage from './CategoriesPage.jsx';
import StockMovementsPage from './StockMovementsPage.jsx';
import CashHandoverPage from './CashHandoverPage.jsx';
import ReportsPage from './ReportsPage.jsx';
import UsersPage from './UsersPage.jsx';
import AuditPage from './AuditPage.jsx';
import ImportPage from './ImportPage.jsx';
import SettingsPage from './SettingsPage.jsx';
import SupplierOrdersPage from '../supplier/SupplierOrdersPage.jsx';
import { ROLE_LABELS, canOpenPage, firstStaffPage } from '../../utils/roles.js';

const NAV = [
  ['', 'Dashboard'],
  ['sell', 'Sell'],
  ['sales', 'Sales'],
  ['voids', 'Voids'],
  ['products', 'Products'],
  ['categories', 'Categories'],
  ['stock', 'Stock log'],
  ['cash', 'Cash handover'],
  ['money', 'Money'],
  ['reports', 'Reports'],
  ['users', 'Users'],
  ['audit', 'Audit log'],
  ['import', 'Import'],
  ['settings', 'Settings'],
  ['suppliers', 'Supplier lists'],
];

export default function AdminLayout() {
  const { profile, signOut } = useAuth();
  const { settings } = useSettings();
  const online = useOnlineStatus();
  const location = useLocation();
  const [pending, setPending] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);

  const refreshPending = useCallback(() => { if (profile.role === 'admin') pendingVoidCount().then(setPending, () => {}); }, [profile.role]);
  useEffect(() => {
    refreshPending();
  }, [refreshPending]);
  useRealtime(['void_requests'], refreshPending, { enabled: profile.role === 'admin' });
  useEffect(() => setMenuOpen(false), [location.pathname]);

  return (
    <div className="app-shell">
      <header className="topbar admin-top">
        <button type="button" className="btn-ghost menu-btn" onClick={() => setMenuOpen((o) => !o)} aria-label="Menu">
          ☰
        </button>
        <div className="brand">
          <span className="logo">AD</span>
          <div>
            {ROLE_LABELS[profile.role]}<small>{settings.event_name}</small>
          </div>
        </div>
        <nav className={`tabs admin-tabs ${menuOpen ? 'open' : ''}`}>
          {NAV.filter(([to]) => canOpenPage(profile.role, to)).map(([to, label]) => (
            <NavLink key={to} to={`/admin${to ? `/${to}` : ''}`} end={to === ''} className={({ isActive }) => `tab ${isActive ? 'on' : ''}`}>
              {label}
              {to === 'voids' && pending > 0 && <span className="cnt">{pending}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="who">
          <span className={`pill ${online ? 'on' : 'off'}`}>{online ? 'Online' : 'Offline'}</span>
          <div className="u">
            {profile.full_name || profile.username}
            <small>{ROLE_LABELS[profile.role]}</small>
          </div>
          <button type="button" className="btn-ghost" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <ConnectionBanner />
      <main className="main">
        <Routes>
          <Route index element={canOpenPage(profile.role, '') ? <Dashboard pendingVoids={pending} /> : <Navigate to={firstStaffPage(profile.role)} replace />} />
          <Route path="sell" element={canOpenPage(profile.role, 'sell') ? <SellPage /> : <Navigate to={firstStaffPage(profile.role)} replace />} />
          <Route path="sales" element={canOpenPage(profile.role, 'sales') ? <SalesPage /> : <Navigate to={firstStaffPage(profile.role)} replace />} />
          <Route path="voids" element={canOpenPage(profile.role, 'voids') ? <VoidsPage onChange={refreshPending} /> : <Navigate to={firstStaffPage(profile.role)} replace />} />
          <Route path="products" element={canOpenPage(profile.role, 'products') ? <ProductsPage /> : <Navigate to={firstStaffPage(profile.role)} replace />} />
          <Route path="categories" element={canOpenPage(profile.role, 'categories') ? <CategoriesPage /> : <Navigate to={firstStaffPage(profile.role)} replace />} />
          <Route path="stock" element={canOpenPage(profile.role, 'stock') ? <StockMovementsPage /> : <Navigate to={firstStaffPage(profile.role)} replace />} />
          <Route path="money" element={canOpenPage(profile.role, 'money') ? <MoneyPage /> : <Navigate to={firstStaffPage(profile.role)} replace />} />
          <Route path="cash" element={canOpenPage(profile.role, 'cash') ? <CashHandoverPage /> : <Navigate to={firstStaffPage(profile.role)} replace />} />
          <Route path="reports" element={canOpenPage(profile.role, 'reports') ? <ReportsPage /> : <Navigate to={firstStaffPage(profile.role)} replace />} />
          <Route path="users" element={canOpenPage(profile.role, 'users') ? <UsersPage /> : <Navigate to={firstStaffPage(profile.role)} replace />} />
          <Route path="audit" element={canOpenPage(profile.role, 'audit') ? <AuditPage /> : <Navigate to={firstStaffPage(profile.role)} replace />} />
          <Route path="import" element={canOpenPage(profile.role, 'import') ? <ImportPage /> : <Navigate to={firstStaffPage(profile.role)} replace />} />
          <Route path="settings" element={canOpenPage(profile.role, 'settings') ? <SettingsPage /> : <Navigate to={firstStaffPage(profile.role)} replace />} />
          <Route path="suppliers" element={canOpenPage(profile.role, 'suppliers') ? <SupplierOrdersPage /> : <Navigate to={firstStaffPage(profile.role)} replace />} />
          <Route path="*" element={<Navigate to={firstStaffPage(profile.role)} replace />} />
        </Routes>
      </main>
    </div>
  );
}
