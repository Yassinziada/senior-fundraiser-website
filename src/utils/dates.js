// Date helpers. "Business dates" are calendar dates in the EVENT timezone
// (Admin setting, default Africa/Cairo), matching how the database groups sales.

/** 'YYYY-MM-DD' for "now" (or a given Date) in the given IANA timezone. */
export function dateInTz(timeZone = 'Africa/Cairo', date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const get = (t) => parts.find((p) => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** Add n days to 'YYYY-MM-DD'. */
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function formatDateTime(iso, { locale = 'en-EG', timeZone = 'Africa/Cairo' } = {}) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat(locale, { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

export function formatTime(iso, { locale = 'en-EG', timeZone = 'Africa/Cairo' } = {}) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleTimeString();
  }
}

/** Start of the business day as an ISO instant, for timestamp filters. */
export function dayStartISO(dateStr, timeZone = 'Africa/Cairo') {
  // find the UTC instant whose local date in timeZone is dateStr at 00:00
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offsetAt = (ms) => {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(new Date(ms));
      const g = (t) => Number(parts.find((p) => p.type === t).value);
      return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - ms;
    } catch {
      return 0;
    }
  };
  let ms = guess - offsetAt(guess);
  ms = guess - offsetAt(ms); // second pass handles DST edges
  return new Date(ms).toISOString();
}

export const DATE_PRESETS = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: 'Last 7 days' },
  { id: 'all', label: 'All time' },
  { id: 'custom', label: 'Custom' },
];

export function rangeForPreset(preset, timeZone) {
  const today = dateInTz(timeZone);
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case '7d':
      return { from: addDays(today, -6), to: today };
    case 'all':
    default:
      return { from: '2000-01-01', to: addDays(today, 1) };
  }
}
