import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { useSettings } from '../context/SettingsContext.jsx';
import { useOnlineStatus } from '../hooks/useOnlineStatus.js';

/**
 * One login form for everyone:
 *  - cashiers type their USERNAME + numeric PIN (big PIN pad, like the old POS)
 *  - admins type their EMAIL + password
 * Credentials are checked by Supabase Auth (bcrypt hashes, rate limited);
 * nothing secret is stored in the browser except the session token.
 */
export default function LoginPage() {
  const { signIn } = useAuth();
  const { settings } = useSettings();
  const online = useOnlineStatus();
  const [loginId, setLoginId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const isEmail = loginId.includes('@');

  const submit = async (e) => {
    e?.preventDefault();
    if (!loginId.trim() || !secret || busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(loginId, secret);
    } catch (err) {
      setError(err.message);
      setSecret('');
      setBusy(false);
    }
  };

  const key = (k) => {
    if (k === 'C') setSecret((s) => s.slice(0, -1));
    else if (k === 'E') submit();
    else setSecret((s) => (s.length < 12 ? s + k : s));
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="logo big">POS</span>
          <div>
            <h1>{settings.event_name}</h1>
            <div className="muted">Sign in to continue</div>
          </div>
        </div>
        {!online && <div className="notice bad" style={{ marginTop: 16 }}>No internet connection. Internet connection required.</div>}
        <label className="f" style={{ marginTop: 18 }}>
          Username (cashier) or email (staff)
          <input
            className="input"
            value={loginId}
            onChange={(e) => setLoginId(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="username"
            autoFocus
            placeholder="e.g. bazaar1"
          />
        </label>
        <label className="f">
          {isEmail ? 'Password' : 'PIN'}
          <input
            className="input"
            type="password"
            inputMode={isEmail ? 'text' : 'numeric'}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {!isEmail && (
          <div className="pinpad" aria-hidden="true">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) => (
              <button type="button" key={n} onClick={() => key(n)} tabIndex={-1}>
                {n}
              </button>
            ))}
            <button type="button" onClick={() => key('C')} tabIndex={-1}>
              ⌫
            </button>
            <button type="button" onClick={() => key('0')} tabIndex={-1}>
              0
            </button>
            <button type="button" className="go" onClick={() => key('E')} tabIndex={-1} disabled={busy}>
              Enter
            </button>
          </div>
        )}
        {error && (
          <div className="notice bad" role="alert" style={{ marginTop: 14 }}>
            {error}
          </div>
        )}
        <button type="submit" className="btn primary" style={{ width: '100%', padding: 12, marginTop: 14 }} disabled={busy || !online}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
