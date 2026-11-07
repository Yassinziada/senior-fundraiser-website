// =============================================================================
// Supabase Edge Function: admin-users
//
// Why this exists: creating login accounts and setting passwords/PINs needs
// the Supabase SERVICE ROLE key, which must NEVER be in the browser. This
// function runs on Supabase's servers, where that key is provided
// automatically as an environment variable, and it only acts after checking
// that the caller is an ACTIVE ADMIN.
//
// Actions (POST JSON body):
//   { action: "create_user", username, full_name, pin, role: "cashier"|"admin", section?, email }
//   { action: "reset_credentials", user_id, pin }
//
// Security: deployed with gateway JWT verification OFF (--no-verify-jwt) so it
// works with every Supabase key type; the function itself validates the
// caller's session with Supabase Auth and requires an ACTIVE ADMIN profile.
//
// Deploy: see README ("Deploy the admin-users function").
//
// No external imports: it talks to Supabase's Auth and REST APIs with plain
// fetch(), so nothing has to be downloaded when the function starts.
// =============================================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

const USERNAME_RE = /^[a-z0-9._-]{2,40}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Cashier PIN: 6–12 digits (Supabase requires at least 6 characters).
const PIN_RE = /^\d{6,12}$/;

function validSecret(role: string, pin: string) {
  if (role === 'cashier') return PIN_RE.test(pin);
  // admins: a real password, at least 10 characters
  return typeof pin === 'string' && pin.length >= 10 && pin.length <= 72;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const url = Deno.env.get('SUPABASE_URL');
  // SUPABASE_SERVICE_ROLE_KEY is provided automatically. Projects that have
  // disabled legacy API keys can instead add a secret called POS_SERVICE_KEY
  // (Edge Functions -> Secrets) containing a "sb_secret_..." key.
  const serviceKey = Deno.env.get('POS_SERVICE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return json(500, { error: 'Function is missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' });

  // Service-key requests bypass RLS — they are only made AFTER the admin check.
  // (New-style "sb_secret_" keys go in the apikey header only; legacy JWT keys
  // are also sent as the bearer token.)
  const serviceHeaders: Record<string, string> = { apikey: serviceKey, 'Content-Type': 'application/json' };
  if (!serviceKey.startsWith('sb_')) serviceHeaders.Authorization = `Bearer ${serviceKey}`;

  const rest = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...serviceHeaders, ...(init.headers ?? {}) } });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(data?.message ?? `Database request failed (${res.status})`);
    return data;
  };
  const one = async (path: string) => ((await rest(path)) as unknown[])[0] as Record<string, any> | undefined;
  const authAdmin = async (path: string, method: string, payload: unknown) => {
    const res = await fetch(`${url}/auth/v1/admin/${path}`, { method, headers: serviceHeaders, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.msg ?? data?.message ?? data?.error_description ?? `Auth request failed (${res.status})`);
    return data;
  };

  // ---- 1. who is calling? --------------------------------------------------
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Not signed in' });
  const userRes = await fetch(`${url}/auth/v1/user`, { headers: { apikey: serviceKey, Authorization: `Bearer ${token}` } });
  if (!userRes.ok) return json(401, { error: 'Session expired. Please sign in again.' });
  const caller = await userRes.json();

  let callerProfile: Record<string, any> | undefined;
  try {
    callerProfile = await one(`profiles?id=eq.${encodeURIComponent(caller.id)}&select=id,role,active,full_name,username`);
  } catch (e) {
    return json(500, { error: (e as Error).message });
  }
  if (!callerProfile || callerProfile.role !== 'admin' || !callerProfile.active) {
    return json(403, { error: 'Only an active admin can manage users.' });
  }

  const audit = (action: string, section: string | null, entityId: string, details: Record<string, unknown>) =>
    rest('audit_logs', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        actor_id: callerProfile!.id,
        actor_name: callerProfile!.full_name || callerProfile!.username,
        actor_role: 'admin',
        action,
        section_code: section,
        entity_type: 'profile',
        entity_id: entityId,
        details,
      }),
    }).catch(() => null);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  // ---- 2. create a user ----------------------------------------------------
  if (body.action === 'create_user') {
    const username = String(body.username ?? '').trim().toLowerCase();
    const fullName = String(body.full_name ?? '').trim().slice(0, 80);
    const role = String(body.role ?? 'cashier');
    if (!['admin', 'cashier', 'finance', 'product_manager', 'supplier'].includes(role)) return json(400, { error: 'Invalid role.' });
    const section = role === 'cashier' ? String(body.section ?? '') : null;
    const email = String(body.email ?? '').trim().toLowerCase();
    const pin = String(body.pin ?? '');

    if (!USERNAME_RE.test(username)) return json(400, { error: 'Username: 2–40 characters, lowercase letters, digits, dot, dash or underscore.' });
    if (!EMAIL_RE.test(email)) return json(400, { error: 'Invalid login email.' });
    if (!validSecret(role, pin)) {
      return json(400, { error: role === 'cashier' ? 'PIN must be 6 to 12 digits.' : 'Password must be 10 to 72 characters.' });
    }
    try {
      if (role === 'cashier' && !(await one(`sections?code=eq.${encodeURIComponent(section!)}&select=code`))) {
        return json(400, { error: 'Choose a valid section.' });
      }
      if (await one(`profiles?username=eq.${encodeURIComponent(username)}&select=id`)) {
        return json(409, { error: 'That username is already used.' });
      }
      // app_metadata can only be set with the service key; the database trigger
      // handle_new_auth_user() reads it to create an ACTIVE profile.
      const created = await authAdmin('users', 'POST', {
        email,
        password: pin,
        email_confirm: true,
        app_metadata: { pos_role: role, pos_section: section, pos_username: username, pos_full_name: fullName || username },
      });
      const userId = created.id ?? created.user?.id;
      // Make sure the profile is active with the right role/section even if
      // the database trigger ran before Auth stored the app_metadata.
      await rest(`profiles?id=eq.${userId}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ username, full_name: fullName || username, role, section_code: section, active: true }),
      });
      await audit('user_created', section, userId, { username, full_name: fullName, role, section, email });
      return json(200, { ok: true, user_id: userId });
    } catch (e) {
      return json(400, { error: (e as Error).message });
    }
  }

  // ---- 3. reset PIN / password --------------------------------------------
  if (body.action === 'reset_credentials') {
    const userId = String(body.user_id ?? '');
    const pin = String(body.pin ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return json(400, { error: 'Invalid user id.' });
    try {
      const target = await one(`profiles?id=eq.${userId}&select=id,role,username,section_code`);
      if (!target) return json(404, { error: 'User not found.' });
      if (!validSecret(target.role, pin)) {
        return json(400, { error: target.role === 'cashier' ? 'PIN must be 6 to 12 digits.' : 'Password must be at least 10 characters.' });
      }
      await authAdmin(`users/${userId}`, 'PUT', { password: pin });
      // never log the secret itself
      await audit('credentials_reset', target.section_code, userId, { username: target.username });
      return json(200, { ok: true });
    } catch (e) {
      return json(400, { error: (e as Error).message });
    }
  }

  return json(400, { error: 'Unknown action' });
});
