import { useAuth } from '../context/AuthContext.jsx';

export function ConfigErrorPage({ message }) {
  return (
    <div className="login">
      <div className="login-card">
        <h1>Setup needed</h1>
        <p className="notice bad">{message}</p>
        <p>
          Create a file called <code>.env.local</code> in the project folder (copy <code>.env.example</code>) and fill in{' '}
          <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> from Supabase → Project Settings → API. Then restart{' '}
          <code>npm run dev</code>.
        </p>
        <p>
          On Vercel: Project → Settings → Environment Variables, add both, then <b>Redeploy</b>.
        </p>
      </div>
    </div>
  );
}

export function InactivePage() {
  const { profile, signOut } = useAuth();
  return (
    <div className="login">
      <div className="login-card">
        <h1>Account not active</h1>
        <p>
          You are signed in as <b>{profile?.username ?? 'unknown user'}</b>, but this account is not active
          {profile && profile.role === 'cashier' && !profile.section_code ? ' or has no section (Bazaar/Snacks) assigned' : ''}.
        </p>
        <p className="muted">Ask the admin to activate your account in Admin → Users.</p>
        <button type="button" className="btn primary" onClick={signOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}

export function LoadErrorPage({ error }) {
  const { signOut } = useAuth();
  return (
    <div className="login">
      <div className="login-card">
        <h1>Cannot load your account</h1>
        <p className="notice bad">{error?.message ?? 'Unknown error'}</p>
        <p className="muted">
          {error?.network
            ? 'Check the internet connection and reload the page.'
            : 'If this persists, make sure all database migrations were run (see README → Troubleshooting).'}
        </p>
        <div className="actions">
          <button type="button" className="btn primary" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button type="button" className="btn" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
