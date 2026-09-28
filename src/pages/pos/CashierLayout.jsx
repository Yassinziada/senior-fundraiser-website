import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { useSettings } from '../../context/SettingsContext.jsx';
import { useOnlineStatus } from '../../hooks/useOnlineStatus.js';
import ConnectionBanner from '../../components/ConnectionBanner.jsx';
import { sectionLabel } from '../../utils/format.js';
import PosPage from './PosPage.jsx';
import MySales from './MySales.jsx';

/** Cashier shell: no admin navigation at all — just Sell and My sales. */
export default function CashierLayout() {
  const { profile, signOut } = useAuth();
  const { settings, sections } = useSettings();
  const online = useOnlineStatus();
  const section = profile.section_code;
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="logo">{section === 'SNACKS' ? 'SN' : 'BZ'}</span>
          <div>
            {sectionLabel(section, sections)} POS<small>{settings.event_name}</small>
          </div>
        </div>
        <nav className="tabs">
          <NavLink to="/pos" end className={({ isActive }) => `tab ${isActive ? 'on' : ''}`}>
            Sell
          </NavLink>
          <NavLink to="/pos/sales" className={({ isActive }) => `tab ${isActive ? 'on' : ''}`}>
            My sales
          </NavLink>
        </nav>
        <div className="who">
          <span className={`pill ${online ? 'on' : 'off'}`}>{online ? 'Online' : 'Offline'}</span>
          <div className="u">
            {profile.full_name || profile.username}
            <small>Cashier · {sectionLabel(section, sections)}</small>
          </div>
          <button type="button" className="btn-ghost" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <ConnectionBanner />
      <main className="main main-pos-wrap">
        <Routes>
          <Route index element={<PosPage section={section} />} />
          <Route path="sales" element={<MySales />} />
          <Route path="*" element={<Navigate to="/pos" replace />} />
        </Routes>
      </main>
    </div>
  );
}
