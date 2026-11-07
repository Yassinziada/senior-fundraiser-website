export const PAYMENT_METHODS = [
  { id: 'CASH', label: 'Cash' },
  { id: 'TELDA', label: 'Telda' },
];

export const paymentLabel = (id) => PAYMENT_METHODS.find((m) => m.id === id)?.label ?? (id === 'INSTAPAY' ? 'InstaPay (historical)' : id);

export function sectionLabel(code, sections = []) {
  return sections.find((s) => s.code === code)?.name ?? (code ? code.charAt(0) + code.slice(1).toLowerCase() : 'All');
}

export function pct(v) {
  return v === null || v === undefined ? '—' : `${Number(v).toFixed(1)}%`;
}

export function int(v) {
  return Number(v ?? 0).toLocaleString('en-US');
}

export function humanAction(a) {
  return String(a ?? '').replace(/_/g, ' ');
}
