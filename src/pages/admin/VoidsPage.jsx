import { useState } from 'react';
import { useSettings } from '../../context/SettingsContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { useRealtime } from '../../hooks/useRealtime.js';
import { decideVoid, fetchVoidRequests } from '../../services/admin.js';
import { ErrorNotice, Spinner, Badge } from '../../components/ui.jsx';
import ReasonDialog from '../../components/ReasonDialog.jsx';
import { formatDateTime } from '../../utils/dates.js';
import { paymentLabel, sectionLabel } from '../../utils/format.js';
import { exportCSV } from '../../utils/csv.js';
import TransactionDetail from './TransactionDetail.jsx';

const who = (p) => (p ? p.full_name || p.username : '—');
const TONE = { pending: 'warn', approved: 'bad', rejected: 'muted' };

export default function VoidsPage({ onChange }) {
  const { money, sections, dateOpts } = useSettings();
  const toast = useToast();
  const [tab, setTab] = useState('pending');
  const { data, error, loading, reload } = useAsync(() => fetchVoidRequests(tab === 'all' ? null : tab), [tab]);
  useRealtime(['void_requests'], () => reload({ silent: true }));
  const [deciding, setDeciding] = useState(null); // { req, approve }
  const [openId, setOpenId] = useState(null);

  const rows = data ?? [];
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Void requests</h1>
          <p>Approving voids the sale, records the refund and returns the items to stock (exactly once). Nothing is deleted.</p>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() =>
            exportCSV('void_requests', rows, [
              { key: 'txn', label: 'Transaction', value: (r) => r.txn?.txn_no },
              { key: 'section_code', label: 'Section' },
              { key: 'amount', label: 'Amount', value: (r) => r.txn?.total },
              { key: 'payment', label: 'Payment', value: (r) => r.txn?.payment_method },
              { key: 'reason', label: 'Reason' },
              { key: 'requester', label: 'Requested by', value: (r) => who(r.requester) },
              { key: 'requested_at', label: 'Requested at', value: (r) => formatDateTime(r.requested_at, dateOpts) },
              { key: 'status', label: 'Status' },
              { key: 'decider', label: 'Decided by', value: (r) => (r.decider ? who(r.decider) : '') },
              { key: 'decided_at', label: 'Decided at', value: (r) => formatDateTime(r.decided_at, dateOpts) },
              { key: 'decision_note', label: 'Note' },
            ])
          }
        >
          Export CSV
        </button>
      </div>
      <div className="subtabs">
        {['pending', 'approved', 'rejected', 'all'].map((s) => (
          <button type="button" key={s} className={`subtab ${tab === s ? 'on' : ''}`} onClick={() => setTab(s)}>
            {s[0].toUpperCase() + s.slice(1)}
          </button>
        ))}
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
                <th>Section</th>
                <th className="num">Amount</th>
                <th>Reason</th>
                <th>Requested</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 30 }}>
                    Nothing here.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <button type="button" className="linklike" onClick={() => setOpenId(r.transaction_id)}>
                      {r.txn?.txn_no}
                    </button>
                    <div className="muted small">{paymentLabel(r.txn?.payment_method)}</div>
                  </td>
                  <td>{sectionLabel(r.section_code, sections)}</td>
                  <td className="num">{money(r.txn?.total)}</td>
                  <td className="items">{r.reason}</td>
                  <td>
                    {who(r.requester)}
                    <div className="muted small">{formatDateTime(r.requested_at, dateOpts)}</div>
                  </td>
                  <td>
                    <Badge tone={TONE[r.status]}>{r.status.toUpperCase()}</Badge>
                    {r.decided_at && (
                      <div className="muted small">
                        {who(r.decider)} · {formatDateTime(r.decided_at, dateOpts)}
                        {r.decision_note ? ` · “${r.decision_note}”` : ''}
                      </div>
                    )}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {r.status === 'pending' && (
                      <>
                        <button type="button" className="btn sm danger" onClick={() => setDeciding({ req: r, approve: true })}>
                          Approve
                        </button>{' '}
                        <button type="button" className="btn sm" onClick={() => setDeciding({ req: r, approve: false })}>
                          Reject
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {deciding && (
        <ReasonDialog
          title={`${deciding.approve ? 'Approve' : 'Reject'} void · ${deciding.req.txn?.txn_no}`}
          intro={
            <p>
              {deciding.approve ? (
                <>
                  The sale will be marked VOIDED, a refund of <b>{money(deciding.req.txn?.total)}</b> ({paymentLabel(deciding.req.txn?.payment_method)})
                  is recorded and the items go back into stock.
                </>
              ) : (
                <>The sale stays valid. The request and your rejection are kept on record.</>
              )}
            </p>
          }
          label="Note (optional)"
          required={false}
          confirmLabel={deciding.approve ? 'Approve void' : 'Reject request'}
          danger={deciding.approve}
          onClose={() => setDeciding(null)}
          onSubmit={async (note) => {
            await decideVoid(deciding.req.id, deciding.approve, note);
            toast.ok(deciding.approve ? 'Void approved, stock restored' : 'Void request rejected');
            setDeciding(null);
            reload({ silent: true });
            onChange?.();
          }}
        />
      )}
      {openId && <TransactionDetail id={openId} onClose={() => setOpenId(null)} onChanged={() => reload({ silent: true })} />}
    </div>
  );
}
