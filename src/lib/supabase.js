// The ONE Supabase client used by the app.
// Only the public URL + anon/publishable key are used here. They are safe to
// ship to browsers: every read/write is authorised by the database (RLS and
// secure functions) using the signed-in user's token.
// NEVER import or reference a service_role / secret key in frontend code.
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const cashierEmailDomain = import.meta.env.VITE_CASHIER_EMAIL_DOMAIN || 'cashiers.school-pos.app';

/** Non-null when the app was built without its environment variables. */
export const configError =
  !url || !anonKey
    ? 'VITE_SUPABASE_URL and/or VITE_SUPABASE_ANON_KEY are not set.'
    : /service_role|sb_secret_/.test(anonKey) || isServiceRoleJwt(anonKey)
      ? 'VITE_SUPABASE_ANON_KEY contains a SERVICE ROLE / SECRET key. Replace it with the anon/publishable key immediately and rotate the secret key in Supabase.'
      : null;

function isServiceRoleJwt(key) {
  try {
    const payload = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload?.role === 'service_role';
  } catch {
    return false;
  }
}

export const supabase = configError
  ? null
  : createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 5 } },
    });
