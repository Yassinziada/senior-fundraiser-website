import { useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { submitMoney } from '../services/money.js';
import { readJSON } from '../utils/localStore.js';

// Persist the exact payload before sending. A lost response must be retried with
// the same UUID, even after closing a modal or refreshing the page.
export function useMoneyAction(scope) {
  const { profile } = useAuth();
  const key = `pos.money.${scope}.${profile.id}`;
  const [pending, setPending] = useState(() => readJSON(key));
  const pendingRef = useRef(pending);
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const send = async (action) => {
    if (locked.current) return false;
    locked.current = true; setBusy(true); setError(null);
    try {
      const request = pendingRef.current || action;
      localStorage.setItem(key, JSON.stringify(request));
      pendingRef.current = request; setPending(request);
      const data = await submitMoney(request);
      localStorage.removeItem(key); pendingRef.current = null; setPending(null);
      return { data };
    } catch (e) {
      // Only a definite server rejection proves the transaction did not commit.
      if (!e.network && typeof e.code === 'string') {
        localStorage.removeItem(key); pendingRef.current = null; setPending(null);
      }
      setError(e.message); return false;
    } finally { locked.current = false; setBusy(false); }
  };
  return { pending, busy, error, send };
}
