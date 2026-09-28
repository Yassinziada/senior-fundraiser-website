import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase.js';

/**
 * Subscribe to row changes on the given tables and call onChange (debounced).
 * Realtime respects RLS: a cashier only receives their own section's product
 * rows; admin-only tables deliver nothing to cashiers.
 * A slow polling fallback keeps screens fresh if the websocket drops.
 */
export function useRealtime(tables, onChange, { enabled = true, debounceMs = 600, pollMs = 30_000, filter } = {}) {
  const cbRef = useRef(onChange);
  cbRef.current = onChange;
  const key = tables.join(',') + (filter ?? '');

  useEffect(() => {
    if (!enabled || !supabase) return undefined;
    let timer = null;
    const fire = () => {
      clearTimeout(timer);
      timer = setTimeout(() => cbRef.current?.(), debounceMs);
    };
    const channel = supabase.channel(`rt:${key}:${Math.random().toString(36).slice(2)}`);
    for (const table of tables) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) }, fire);
    }
    channel.subscribe();
    const poll = pollMs ? setInterval(() => cbRef.current?.(), pollMs) : null;
    const onVisible = () => document.visibilityState === 'visible' && fire();
    const onOnline = () => fire();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, debounceMs, pollMs]);
}
