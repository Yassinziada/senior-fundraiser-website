// Money helpers.
// Rule: arithmetic in the browser is done in integer CENTS (piasters), never
// with floating-point amounts. Amounts coming from the database (numeric(12,2))
// arrive as JSON numbers like 12.35 and are converted with toCents().
// The database is the source of truth for every stored total; the browser only
// uses these for display, cart previews and change preview.

/** Convert 12.35 / "12.35" / "1,234.5" to 1235 (integer cents). NaN if invalid. */
export function toCents(value) {
  if (value === null || value === undefined || value === '') return NaN;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return NaN;
    return Math.round(value * 100);
  }
  const s = String(value).trim().replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  const neg = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2)) + (Number(frac[2] ?? 0) >= 5 ? 1 : 0);
  return neg ? -cents : cents;
}

/** 1235 -> 12.35 (number, for sending to the database / display). */
export function centsToAmount(cents) {
  return Math.round(cents) / 100;
}

/** 1235 -> "12.35" */
export function centsToString(cents) {
  const neg = cents < 0;
  const a = Math.abs(Math.round(cents));
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/**
 * Parse what a cashier typed into "amount received". Accepts "200", "200.5",
 * "1,000.25". Rejects negatives, letters and more than 2 decimals. -> cents or NaN
 */
export function parseAmountInput(text) {
  const s = String(text ?? '').trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return toCents(s);
}

/** Change for a cash payment, all in cents. */
export function calcChange(totalCents, receivedCents) {
  if (!Number.isFinite(receivedCents) || Number.isNaN(receivedCents)) {
    return { valid: false, change: 0, short: 0 };
  }
  if (receivedCents < totalCents) return { valid: false, change: 0, short: totalCents - receivedCents };
  return { valid: true, change: receivedCents - totalCents, short: 0 };
}

export function sumCents(items, pick = (x) => x) {
  return items.reduce((acc, x) => acc + pick(x), 0);
}

/**
 * Build a formatter from the app settings (currency + locale are Admin
 * settings, not hard-coded). Accepts an AMOUNT (e.g. 12.5), not cents.
 * Whole amounts print without decimals, like the original POS ("25 EGP").
 */
export function createMoneyFormatter({ currency_code = 'EGP', locale = 'en-EG' } = {}) {
  const cache = new Map();
  const get = (digits) => {
    if (!cache.has(digits)) {
      try {
        cache.set(
          digits,
          new Intl.NumberFormat(locale, {
            style: 'currency',
            currency: currency_code,
            currencyDisplay: 'code',
            minimumFractionDigits: digits,
            maximumFractionDigits: 2,
          }),
        );
      } catch {
        cache.set(digits, null);
      }
    }
    return cache.get(digits);
  };
  return function formatMoney(amount) {
    if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return '—';
    const cents = toCents(Number(amount));
    const digits = cents % 100 === 0 ? 0 : 2;
    const f = get(digits);
    const n = centsToAmount(cents);
    if (!f) return `${n.toFixed(digits)} ${currency_code}`;
    return f.format(n);
  };
}
