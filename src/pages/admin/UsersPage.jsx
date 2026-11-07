import { useState } from 'react';
import { ROLE_LABELS } from '../../utils/roles.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useSettings } from '../../context/SettingsContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { createUser, fetchProfiles, resetCredentials, updateUser } from '../../services/admin.js';
import { cashierEmailDomain } from '../../lib/supabase.js';
import Modal from '../../components/Modal.jsx';
import { ErrorNotice, Spinner, Badge } from '../../components/ui.jsx';
import { sectionLabel } from '../../utils/format.js';
import { loginIdToEmail, PIN_PATTERN, USERNAME_PATTERN, normaliseUsername } from '../../utils/login.js';

/**
 * Admin user management. Credentials are handled by Supabase Auth only:
 * this page never sees or stores password hashes, and a PIN is sent once to
 * the admin-users Edge Function which sets it with the service key.
 */
export default function UsersPage() {
  const { profile: me } = useAuth();
  const { sections } = useSettings();
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(() => fetchProfiles(), []);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [resetting, setResetting] = useState(null);

  const users = data ?? [];
  const pending = users.filter((u) => !u.active);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <p>Cashiers see only the POS of their assigned section. Deactivating an account blocks all its data access immediately.</p>
        </div>
        <button type="button" className="btn primary" onClick={() => setCreating(true)}>
          + Create user
        </button>
      </div>
      <ErrorNotice error={error} onRetry={reload} />
      {pending.length > 0 && (
        <div className="notice warn">
          {pending.length} inactive account{pending.length === 1 ? '' : 's'}. Accounts created directly in the Supabase dashboard appear here as inactive
          until you edit them, choose a role/section and activate them.
        </div>
      )}
      {loading && !data ? (
        <Spinner />
      ) : (
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Login</th>
                <th>Role</th>
                <th>Section</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={u.active ? '' : 'dim'}>
                  <td>
                    <b>{u.full_name || u.username}</b>
                    {u.id === me.id && <span className="muted"> (you)</span>}
                  </td>
                  <td>
                    {u.role === 'cashier' ? u.username : u.login_email}
                    <div className="muted small">{u.role === 'cashier' ? 'username + PIN' : 'email + password'}</div>
                  </td>
                  <td><Badge>{ROLE_LABELS[u.role]}</Badge></td>
                  <td>{u.role === 'cashier' ? sectionLabel(u.section_code, sections) : u.role === 'supplier' ? 'Assigned lists' : 'All'}</td>
                  <td>{u.active ? <Badge tone="ok">ACTIVE</Badge> : <Badge tone="bad">INACTIVE</Badge>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button type="button" className="btn sm" onClick={() => setEditing(u)}>
                      Edit
                    </button>{' '}
                    <button type="button" className="btn sm" onClick={() => setResetting(u)}>
                      {u.role === 'cashier' ? 'Reset PIN' : 'Reset password'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <CreateUserModal
          onClose={() => setCreating(false)}
          onCreated={(name) => {
            toast.ok(`${name} created`);
            setCreating(false);
            reload({ silent: true });
          }}
        />
      )}
      {editing && (
        <EditUserModal
          user={editing}
          isSelf={editing.id === me.id}
          onClose={() => setEditing(null)}
          onSaved={() => {
            toast.ok('User updated');
            setEditing(null);
            reload({ silent: true });
          }}
        />
      )}
      {resetting && (
        <ResetModal
          user={resetting}
          onClose={() => setResetting(null)}
          onDone={() => {
            toast.ok('Credentials updated');
            setResetting(null);
          }}
        />
      )}
    </div>
  );
}

function CreateUserModal({ onClose, onCreated }) {
  const { sections } = useSettings();
  const [role, setRole] = useState('cashier');
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [section, setSection] = useState(sections[0]?.code ?? 'BAZAAR');
  const [email, setEmail] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const u = normaliseUsername(username);
  const secretOk = role === 'cashier' ? PIN_PATTERN.test(pin) : pin.length >= 10;
  const valid = USERNAME_PATTERN.test(u) && secretOk && pin === pin2 && (role === 'cashier' || /\S+@\S+\.\S+/.test(email));

  const submit = async (e) => {
    e?.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createUser({
        username: u,
        full_name: fullName.trim(),
        role,
        section: role === 'cashier' ? section : null,
        email: role === 'cashier' ? loginIdToEmail(u, cashierEmailDomain) : email.trim().toLowerCase(),
        pin,
      });
      onCreated(fullName || u);
    } catch (x) {
      setError(x.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Create user"
      onClose={onClose}
      closable={!busy}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={submit} disabled={!valid || busy}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <form onSubmit={submit}>
        <label className="f">Role
          <select aria-label="Role" className="input" value={role} onChange={(e) => setRole(e.target.value)}>
            {Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <div className="frow">
          <label className="f">
            Display name
            <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="e.g. Bazaar Cashier" autoFocus maxLength={80} />
          </label>
          <label className="f">
            Username
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. bazaar1" autoCapitalize="none" />
            <small>Lowercase letters, digits, dot, dash, underscore.</small>
          </label>
        </div>
        {role === 'cashier' ? (
          <label className="f">
            Section
            <select className="input" value={section} onChange={(e) => setSection(e.target.value)}>
              {sections.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="f">
            Email (used to sign in)
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
        )}
        <div className="frow">
          <label className="f">
            {role === 'cashier' ? 'PIN (6–12 digits)' : 'Password (10+ characters)'}
            <input className="input" type="password" inputMode={role === 'cashier' ? 'numeric' : 'text'} value={pin} onChange={(e) => setPin(e.target.value)} autoComplete="new-password" />
          </label>
          <label className="f">
            Repeat
            <input className="input" type="password" inputMode={role === 'cashier' ? 'numeric' : 'text'} value={pin2} onChange={(e) => setPin2(e.target.value)} autoComplete="new-password" />
          </label>
        </div>
        {pin && pin2 && pin !== pin2 && <div className="notice warn">The two entries do not match.</div>}
        {role === 'cashier' && (
          <p className="muted small">
            The cashier signs in with username <b>{u || '…'}</b> and this PIN. Avoid obvious PINs like 123456 or birthdays.
          </p>
        )}
        {error && <div className="notice bad">{error}</div>}
      </form>
    </Modal>
  );
}

function EditUserModal({ user, isSelf, onClose, onSaved }) {
  const { sections } = useSettings();
  const [fullName, setFullName] = useState(user.full_name);
  const [role, setRole] = useState(user.role);
  const [section, setSection] = useState(user.section_code ?? sections[0]?.code ?? 'BAZAAR');
  const [active, setActive] = useState(user.active);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await updateUser({ id: user.id, full_name: fullName, role, section_code: role === 'cashier' ? section : null, active });
      onSaved();
    } catch (x) {
      setError(x.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Edit ${user.full_name || user.username}`}
      onClose={onClose}
      closable={!busy}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <label className="f">
        Display name
        <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={80} />
      </label>
      <div className="frow">
        <label className="f">
          Role
          <select aria-label="Role" className="input" value={role} onChange={(e) => setRole(e.target.value)} disabled={isSelf}>
            {Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        {role === 'cashier' && (
          <label className="f">
            Section
            <select className="input" value={section} onChange={(e) => setSection(e.target.value)}>
              {sections.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <label className="chk">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} disabled={isSelf} /> Active
      </label>
      {isSelf && <p className="muted small">You cannot deactivate or demote your own account.</p>}
      {role === 'admin' && !isSelf && (
        <div className="notice warn" style={{ marginTop: 10 }}>
          Admins can see all costs, profits, reports and users. Only give admin rights to people who need them.
        </div>
      )}
      {error && <div className="notice bad">{error}</div>}
    </Modal>
  );
}

function ResetModal({ user, onClose, onDone }) {
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const isCashier = user.role === 'cashier';
  const valid = (isCashier ? PIN_PATTERN.test(pin) : pin.length >= 10) && pin === pin2;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await resetCredentials(user.id, pin);
      onDone();
    } catch (x) {
      setError(x.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`${isCashier ? 'New PIN' : 'New password'} for ${user.full_name || user.username}`}
      onClose={onClose}
      closable={!busy}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={submit} disabled={!valid || busy}>
            {busy ? 'Saving…' : 'Set'}
          </button>
        </>
      }
    >
      <div className="frow">
        <label className="f">
          {isCashier ? 'New PIN (6–12 digits)' : 'New password (10+ characters)'}
          <input className="input" type="password" inputMode={isCashier ? 'numeric' : 'text'} value={pin} onChange={(e) => setPin(e.target.value)} autoFocus autoComplete="new-password" />
        </label>
        <label className="f">
          Repeat
          <input className="input" type="password" inputMode={isCashier ? 'numeric' : 'text'} value={pin2} onChange={(e) => setPin2(e.target.value)} autoComplete="new-password" />
        </label>
      </div>
      {error && <div className="notice bad">{error}</div>}
    </Modal>
  );
}
