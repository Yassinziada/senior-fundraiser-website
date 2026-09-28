import { useCallback, useState } from 'react';
import { useSettings } from '../../context/SettingsContext.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { fetchStockMovements } from '../../services/admin.js';
import { SectionFilter, DateRangeFilter, initialRange } from '../../components/Filters.jsx';
import { ErrorNotice, Spinner, Badge } from '../../components/ui.jsx';
import { addDays, dayStartISO, formatDateTime } from '../../utils/dates.js';
import { sectionLabel } from '../../utils/format.js';
import { exportCSV } from '../../utils/csv.js';

const TYPES = {
  initial: ['Starting stock', 'info'],
  sale: ['Sale', 'muted'],
  void_restore: ['Void restore', 'warn'],
  adjust_add: ['Added', 'ok'],
  adjust_remove: ['Removed', 'bad'],
};

export function movementLabel(t) {
  return TYPES[t]?.[0] ?? t;
}

export default function StockMovementsPage() {
  const { tz, sections, dateOpts } = useSettings();
  const [section, setSection] = useState('');
  const [range, setRange] = useState(() => initialRange('7d', tz));
  const [type, setType] = useState('');
  const loader = useCallback(
    () =>
      fetchStockMovements({
        from: dayStartISO(range.from, tz),
        to: dayStartISO(addDays(range.to, 1), tz),
        section: section || null,
        type: type || null,
      }),
    [range.from, range.to, section, type, tz],
  );
  const { data, error, loading, reload } = useAsync(loader, [loader]);
  const rows = data ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Stock movements</h1>
          <p>Every change to stock: starting stock, sales, void restores and manual adjustments (with reasons). Latest 1,000 shown.</p>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() =>
            exportCSV('stock_movements', rows, [
              { key: 'created_at', label: 'Date/time', value: (r) => formatDateTime(r.created_at, dateOpts) },
              { key: 'section_code', label: 'Section' },
              { key: 'product', label: 'Product', value: (r) => r.product?.name },
              { key: 'movement_type', label: 'Type', value: (r) => movementLabel(r.movement_type) },
              { key: 'quantity_change', label: 'Change' },
              { key: 'stock_before', label: 'Before' },
              { key: 'stock_after', label: 'After' },
              { key: 'reason', label: 'Reason' },
              { key: 'txn', label: 'Transaction', value: (r) => r.txn?.txn_no },
              { key: 'by', label: 'By', value: (r) => r.by?.full_name || r.by?.username || 'system' },
            ])
          }
        >
          Export CSV
        </button>
      </div>
      <div className="toolbar">
        <SectionFilter value={section} onChange={setSection} />
        <DateRangeFilter value={range} onChange={setRange} />
        <select className="input" value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
          <option value="">All types</option>
          {Object.entries(TYPES).map(([k, [l]]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <ErrorNotice error={error} onRetry={reload} />
      {loading && !data ? (
        <Spinner />
      ) : (
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Date/time</th>
                <th>Product</th>
                <th>Section</th>
                <th>Type</th>
                <th className="num">Change</th>
                <th className="num">Before → after</th>
                <th>Reason / transaction</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 30 }}>
                    No stock movements in this period.
                  </td>
                </tr>
              )}
              {rows.map((m) => (
                <tr key={m.id}>
                  <td>{formatDateTime(m.created_at, dateOpts)}</td>
                  <td>{m.product?.name}</td>
                  <td>{sectionLabel(m.section_code, sections)}</td>
                  <td>
                    <Badge tone={TYPES[m.movement_type]?.[1]}>{movementLabel(m.movement_type)}</Badge>
                  </td>
                  <td className={`num ${m.quantity_change < 0 ? 'bad-t' : 'ok-t'}`}>
                    {m.quantity_change > 0 ? '+' : ''}
                    {m.quantity_change}
                  </td>
                  <td className="num">
                    {m.stock_before} → {m.stock_after}
                  </td>
                  <td className="items">{m.txn?.txn_no ? `${m.txn.txn_no}${m.reason && m.reason !== m.txn.txn_no ? ` · ${m.reason}` : ''}` : m.reason}</td>
                  <td>{m.by?.full_name || m.by?.username || 'system'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
