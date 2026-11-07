import { useAuth } from '../../context/AuthContext.jsx';
import ConnectionBanner from '../../components/ConnectionBanner.jsx';
import SupplierOrdersPage from './SupplierOrdersPage.jsx';

export default function SupplierLayout() {
  const { profile, signOut } = useAuth();
  return <div className="app-shell">
    <header className="topbar">
      <div className="brand">Supplier lists</div>
      <div className="who"><span>{profile.full_name || profile.username}</span>
        <button className="btn" onClick={signOut}>Sign out</button></div>
    </header>
    <ConnectionBanner />
    <main className="main"><SupplierOrdersPage /></main>
  </div>;
}
