// Stock status used for badges, filters and warnings.
// low  = 0 < stock <= min_stock ; out = stock == 0 ; services never run out.
export function stockStatus(p) {
  if (!p.track_stock) return 'service';
  if (p.stock <= 0) return 'out';
  if (p.stock <= p.min_stock) return 'low';
  return 'ok';
}

export const STOCK_LABEL = { service: 'Service', out: 'Out of stock', low: 'Low stock', ok: 'In stock' };
export const STOCK_TONE = { service: 'info', out: 'bad', low: 'warn', ok: 'ok' };
