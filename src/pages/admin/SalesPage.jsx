import { useCallback, useState } from 'react';
import { useSettings } from '../../context/SettingsContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { useRealtime } from '../../hooks/useRealtime.js';
import { fetchProfiles, fetchTransactions } from '../../services/admin.js';
import { SectionFilter, DateRangeFilter, initialRange } from '../../components/Filters.jsx';
import { ErrorNotice, Spinner, TxnStatusBadge } from '../../components/ui.jsx';
import { formatDateTime } from '../../utils/dates.js';
import { PAYMENT_METHODS, paymentLabel, sectionLabel } from '../../utils/format.js';
import { exportCSV } from '../../utils/csv.js';
import TransactionDetail from './TransactionDetail.jsx';

const PAGE = 50;

export default function SalesPage() {
  const { money, tz, sections, dateOpts } = useSettings();
  const toast = useToast();
  const [section, setSection] = useState('');
  const [range, setRange] = useState(() => initialRange('today', tz));
  const [cashierId, setCashierId] = useState('');
  const [method, setMethod] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState(null);

  const { data: profiles } = useAsync(() => fetchProfiles(), []);
  const filters = { from: range.from, to: range.to, section: section || null, cashierId: cashierId || null, method: method || null, status: status || null, search };
  const loader = useCallback(
    () => fetchTransactions({ ...filters, page, pageSize: PAGE }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range.from, range.to, section, cashierId, method, status, search, page],
  );
  const { data, error, loading, reload } = useAsync(loader, [loader]);
  useRealtime(['transactions', 'void_requests'], () => reload({ silent: true }));

  const rows = data?.data ?? [];
  const count = data?.count ?? 0;
  const setF = (fn) => (v) => {
    fn(v);
    setPage(0);
  };

  const doExport = async () => {
    try {
      const all = await fetchTransactions({ ...filters, page: 0, pageSize: 10000 });
      exportCSV('sales', all.data, [
        { key: 'txn_no', label: 'Transaction' },
        { key: 'created_at', label: 'Date/time', value: (r) => formatDateTime(r.created_at, dateOpts) },
        { key: 'business_date', label: 'Business date' },
        { key: 'section_code', label: 'Section' },
        { key: 'cashier', label: 'Cashier', value: (r) => r.cashier?.full_name || r.cashier?.username },
        { key: 'item_count', label: 'Units' },
        { key: 'total', label: 'Total' },
        { key: 'total_cost', label: 'Cost (at sale)' },
        { key: 'profit', label: 'Est. profit', value: (r) => (Number(r.total) - Number(r.total_cost)).toFixed(2) },
        { key: 'payment_method', label: 'Payment' },
        { key: 'amount_received', label: 'Cash received' },
        { key: 'change_given', label: 'Change' },
        { key: 'status', label: 'Status' },
        { key: 'void_reason', label: 'Void reason' },
      ]);
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Sales history</h1>
          <p>{count} transaction{count === 1 ? '' : 's'} match the filters.</p>
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={doExport}>
            Export CSV
          </button>
        </div>
      </div>
      <div className="toolbar">
        <SectionFilter value={section} onChange={setF(setSection)} />
        <DateRangeFilter value={range} onChange={setF(setRange)} />
        <input className="input" placeholder="Search transaction ID…" value={search} onChange={(e) => setF(setSearch)(e.target.value)} />
        <select className="input" value={cashierId} onChange={(e) => setF(setCashierId)(e.target.value)} aria-label="Cashier">
          <option value="">All cashiers</option>
          {(profiles ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.full_name || p.username}
            </option>
          ))}
        </select>
        <select className="input" value={method} onChange={(e) => setF(setMethod)(e.target.value)} aria-label="Payment method">
          <option value="">All payments</option>
          {PAYMENT_METHODS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <select className="input" value={status} onChange={(e) => setF(setStatus)(e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          <option value="completed">Completed</option>
          <option value="voided">Voided</option>
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
                <th>Transaction</th>
                <th>Date/time</th>
                <th>Section</th>
                <th>Cashier</th>
                <th className="num">Units</th>
                <th>Payment</th>
                <th className="num">Total</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 30 }}>
                    No transactions.
                  </td>
                </tr>
              )}
              {rows.map((t) => {
                const vr = [...(t.void_requests ?? [])].sort((a, b) => b.requested_at.localeCompare(a.requested_at))[0];
                return (
                  <tr key={t.id} className={`clickable ${t.status === 'voided' ? 'dim' : ''}`} onClick={() => setOpenId(t.id)}>
                    <td>
                      <b>{t.txn_no}</b>
                    </td>
                    <td>{formatDateTime(t.created_at, dateOpts)}</td>
                    <td>{sectionLabel(t.section_code, sections)}</td>
                    <td>{t.cashier?.full_name || t.cashier?.username}</td>
                    <td className="num">{t.item_count}</td>
                    <td>{paymentLabel(t.payment_method)}</td>
                    <td className="num">{money(t.total)}</td>
                    <td>
                      <TxnStatusBadge status={t.status} voidRequest={vr} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {count > PAGE && (
        <div className="pager">
          <button type="button" className="btn sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            ‹ Previous
          </button>
          <span className="muted">
            Page {page + 1} of {Math.ceil(count / PAGE)}
          </span>
          <button type="button" className="btn sm" disabled={(page + 1) * PAGE >= count} onClick={() => setPage((p) => p + 1)}>
            Next ›
          </button>
        </div>
      )}
      {openId && <TransactionDetail id={openId} onClose={() => setOpenId(null)} onChanged={() => reload({ silent: true })} />}
    </div>
  );
}
