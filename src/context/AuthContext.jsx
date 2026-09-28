import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { supabase, cashierEmailDomain } from '../lib/supabase.js';
import { loginIdToEmail } from '../utils/login.js';
import { toAppError } from '../utils/errors.js';

const AuthContext = createContext(null);

// status: 'loading' | 'signed-out' | 'ready' | 'inactive' | 'error'
export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);

  const loadProfile = useCallback(async (sess) => {
    if (!sess) {
      setProfile(null);
      setStatus('signed-out');
      return;
    }
    const { data, error: err } = await supabase
      .from('profiles')
      .select('id, username, full_name, role, section_code, active')
      .eq('id', sess.user.id)
      .maybeSingle();
    if (err) {
      setError(toAppError(err));
      setStatus('error');
      return;
    }
    setProfile(data);
    setStatus(data && data.active && (data.role === 'admin' || data.section_code) ? 'ready' : 'inactive');
  }, []);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setSession(data.session);
      loadProfile(data.session);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, sess) => {
      setSession(sess);
      if (event === 'SIGNED_OUT') {
        setProfile(null);
        setStatus('signed-out');
      } else if (event === 'SIGNED_IN' || event === 'USER_UPDATED') {
        // defer: never await Supabase calls inside this callback
        setTimeout(() => loadProfile(sess), 0);
      }
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const signIn = useCallback(async (loginId, secret) => {
    const email = loginIdToEmail(loginId, cashierEmailDomain);
    const { data, error: err } = await supabase.auth.signInWithPassword({ email, password: secret });
    if (err) {
      const e = toAppError(err);
      if (!e.network && /invalid login credentials/i.test(err.message)) e.message = 'Wrong username or PIN/password.';
      throw e;
    }
    // best effort: record the login in the audit log
    supabase.rpc('log_login').then(() => {}, () => {});
    return data;
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut().catch(() => {});
    setProfile(null);
    setStatus('signed-out');
  }, []);

  const value = useMemo(
    () => ({
      session,
      profile,
      status,
      error,
      isAdmin: profile?.role === 'admin' && profile?.active,
      signIn,
      signOut,
      reload: () => loadProfile(session),
    }),
    [session, profile, status, error, signIn, signOut, loadProfile],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
