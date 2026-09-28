// Cashiers sign in with a short username + PIN. Supabase Auth needs an email,
// so a username is mapped to "<username>@<VITE_CASHIER_EMAIL_DOMAIN>".
// Anything containing "@" is used as-is (admins sign in with their real email).
export const DEFAULT_CASHIER_DOMAIN = 'cashiers.school-pos.app';

export function normaliseUsername(u) {
  return String(u ?? '').trim().toLowerCase();
}

export function loginIdToEmail(loginId, domain = DEFAULT_CASHIER_DOMAIN) {
  const id = String(loginId ?? '').trim().toLowerCase();
  if (!id) return '';
  if (id.includes('@')) return id;
  return `${id}@${domain || DEFAULT_CASHIER_DOMAIN}`;
}

export const USERNAME_PATTERN = /^[a-z0-9._-]{2,40}$/;
export const PIN_PATTERN = /^\d{6,12}$/;
