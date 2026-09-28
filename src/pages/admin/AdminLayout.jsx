import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { useSettings } from '../../context/SettingsContext.jsx';
import { useOnlineStatus } from '../../hooks/useOnlineStatus.js';
import { useRealtime } from '../../hooks/useRealtime.js';
import { pendingVoidCount } from '../../services/admin.js';
import ConnectionBanner from '../../components/ConnectionBanner.jsx';
import Dashboard from './Dashboard.jsx';
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

const NAV = [
  ['', 'Dashboard'],
  ['sell', 'Sell'],
  ['sales', 'Sales'],
  ['voids', 'Voids'],
  ['products', 'Products'],
  ['categories', 'Categories'],
  ['stock', 'Stock log'],
  ['cash', 'Cash handover'],
  ['reports', 'Reports'],
  ['users', 'Users'],
  ['audit', 'Audit log'],
  ['import', 'Import'],
  ['settings', 'Settings'],
];

export default function AdminLayout() {
  const { profile, signOut } = useAuth();
  const { settings } = useSettings();
  const online = useOnlineStatus();
  const location = useLocation();
  const [pending, setPending] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);

  const refreshPending = useCallback(() => pendingVoidCount().then(setPending, () => {}), []);
  useEffect(() => {
    refreshPending();
  }, [refreshPending]);
  useRealtime(['void_requests'], refreshPending);
  useEffect(() => setMenuOpen(false), [location.pathname]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <button type="button" className="btn-ghost menu-btn" onClick={() => setMenuOpen((o) => !o)} aria-label="Menu">
          ☰
        </button>
        <div className="brand">
          <span className="logo">AD</span>
          <div>
            Admin<small>{settings.event_name}</small>
          </div>
        </div>
        <nav className={`tabs admin-tabs ${menuOpen ? 'open' : ''}`}>
          {NAV.map(([to, label]) => (
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
            <small>Admin</small>
          </div>
          <button type="button" className="btn-ghost" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <ConnectionBanner />
      <main className="main">
        <Routes>
          <Route index element={<Dashboard pendingVoids={pending} />} />
          <Route path="sell" element={<SellPage />} />
          <Route path="sales" element={<SalesPage />} />
          <Route path="voids" element={<VoidsPage onChange={refreshPending} />} />
          <Route path="products" element={<ProductsPage />} />
          <Route path="categories" element={<CategoriesPage />} />
          <Route path="stock" element={<StockMovementsPage />} />
          <Route path="cash" element={<CashHandoverPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="import" element={<ImportPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </main>
    </div>
  );
}
