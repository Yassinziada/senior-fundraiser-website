import { useCallback, useState } from 'react';
import { useSettings } from '../../context/SettingsContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { fetchAudit } from '../../services/admin.js';
import { SectionFilter, DateRangeFilter, initialRange } from '../../components/Filters.jsx';
import { ErrorNotice, Spinner } from '../../components/ui.jsx';
import { addDays, dayStartISO, formatDateTime } from '../../utils/dates.js';
import { humanAction, sectionLabel } from '../../utils/format.js';
import { exportCSV } from '../../utils/csv.js';

const ACTIONS = [
  'login', 'sale_completed', 'void_requested', 'void_approved', 'void_rejected', 'product_created', 'product_updated',
  'product_activated', 'product_deactivated', 'price_changed', 'cost_changed', 'stock_adjusted', 'category_created',
  'category_updated', 'products_imported', 'user_created', 'user_updated', 'cashier_section_assigned', 'credentials_reset',
  'cash_handover_recorded', 'cash_handover_corrected', 'settings_changed', 'admin_bootstrapped', 'test_data_cleared',
];
const PAGE = 100;

function detailsText(d) {
  if (!d || typeof d !== 'object') return '';
  return Object.entries(d)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' · ');
}

/** Read-only, append-only log. There is no delete/edit anywhere (the database forbids it). */
export default function AuditPage() {
  const { tz, sections, dateOpts } = useSettings();
  const toast = useToast();
  const [range, setRange] = useState(() => initialRange('today', tz));
  const [section, setSection] = useState('');
  const [action, setAction] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const safeSearch = search.replace(/[,()*%\\]/g, ' ').trim();

  const params = { from: dayStartISO(range.from, tz), to: dayStartISO(addDays(range.to, 1), tz), section: section || null, action: action || null, search: safeSearch || null };
  const loader = useCallback(
    () => fetchAudit({ ...params, page, pageSize: PAGE }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range.from, range.to, section, action, safeSearch, page, tz],
  );
  const { data, error, loading, reload } = useAsync(loader, [loader]);
  const rows = data?.data ?? [];
  const count = data?.count ?? 0;
  const reset = (fn) => (v) => {
    fn(v);
    setPage(0);
  };

  const doExport = async () => {
    try {
      const all = await fetchAudit({ ...params, page: 0, pageSize: 10000 });
      exportCSV('audit_log', all.data, [
        { key: 'id', label: 'ID' },
        { key: 'created_at', label: 'Time', value: (r) => formatDateTime(r.created_at, dateOpts) },
        { key: 'actor_name', label: 'User' },
        { key: 'actor_role', label: 'Role' },
        { key: 'action', label: 'Action' },
        { key: 'section_code', label: 'Section' },
        { key: 'entity_type', label: 'Entity' },
        { key: 'entity_id', label: 'Entity ID' },
        { key: 'details', label: 'Details', value: (r) => JSON.stringify(r.details) },
      ]);
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <p>Permanent record of important actions. Entries cannot be edited or deleted. {count} match.</p>
        </div>
        <button type="button" className="btn" onClick={doExport}>
          Export CSV
        </button>
      </div>
      <div className="toolbar">
        <DateRangeFilter value={range} onChange={reset(setRange)} />
        <SectionFilter value={section} onChange={reset(setSection)} />
        <select className="input" value={action} onChange={(e) => reset(setAction)(e.target.value)} aria-label="Action">
          <option value="">All actions</option>
          {ACTIONS.map((a) => (
            <option key={a} value={a}>
              {humanAction(a)}
            </option>
          ))}
        </select>
        <input className="input" placeholder="Search user, action, ID…" value={search} onChange={(e) => reset(setSearch)(e.target.value)} />
      </div>
      <ErrorNotice error={error} onRetry={reload} />
      {loading && !data ? (
        <Spinner />
      ) : (
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Time</th>
                <th>User</th>
                <th>Action</th>
                <th>Section</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 30 }}>
                    No entries.
                  </td>
                </tr>
              )}
              {rows.map((a) => (
                <tr key={a.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(a.created_at, dateOpts)}</td>
                  <td>
                    {a.actor_name}
                    <div className="muted small">{a.actor_role}</div>
                  </td>
                  <td>
                    <b>{humanAction(a.action)}</b>
                    <div className="muted small">
                      {a.entity_type} {a.entity_id ? `#${String(a.entity_id).slice(0, 12)}` : ''}
                    </div>
                  </td>
                  <td>{a.section_code ? sectionLabel(a.section_code, sections) : '—'}</td>
                  <td className="items audit-d">{detailsText(a.details)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {count > PAGE && (
        <div className="pager">
          <button type="button" className="btn sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            ‹ Newer
          </button>
          <span className="muted">
            Page {page + 1} of {Math.ceil(count / PAGE)}
          </span>
          <button type="button" className="btn sm" disabled={(page + 1) * PAGE >= count} onClick={() => setPage((p) => p + 1)}>
            Older ›
          </button>
        </div>
      )}
    </div>
  );
}
