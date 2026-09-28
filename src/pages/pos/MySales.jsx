import { useState } from 'react';
import { useAsync } from '../../hooks/useAsync.js';
import { useSettings } from '../../context/SettingsContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { myTransactions, requestVoid } from '../../services/pos.js';
import { formatTime } from '../../utils/dates.js';
import { paymentLabel } from '../../utils/format.js';
import { ErrorNotice, Spinner, TxnStatusBadge } from '../../components/ui.jsx';
import ReceiptModal from '../../components/ReceiptModal.jsx';
import ReasonDialog from '../../components/ReasonDialog.jsx';

/** A cashier's OWN sales today (no cost/profit, no other cashiers). */
export default function MySales() {
  const { money, dateOpts } = useSettings();
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(() => myTransactions(), []);
  const [view, setView] = useState(null);
  const [voidFor, setVoidFor] = useState(null);

  const list = data ?? [];
  const completed = list.filter((t) => t.status === 'completed');
  const total = completed.reduce((a, t) => a + Math.round(Number(t.total) * 100), 0) / 100;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>My sales today</h1>
          <p>
            {completed.length} completed sale{completed.length === 1 ? '' : 's'} · {money(total)}. Made a mistake? Request a void — the admin must
            approve it.
          </p>
        </div>
        <button type="button" className="btn" onClick={() => reload()}>
          Refresh
        </button>
      </div>
      <ErrorNotice error={error} onRetry={reload} />
      {loading && !data ? (
        <Spinner />
      ) : (
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Receipt</th>
                <th>Time</th>
                <th>Items</th>
                <th>Payment</th>
                <th className="num">Total</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 30 }}>
                    No sales yet today.
                  </td>
                </tr>
              )}
              {list.map((t) => {
                const canVoid = t.status === 'completed' && t.void_request?.status !== 'pending';
                return (
                  <tr key={t.id} className={t.status === 'voided' ? 'dim' : ''}>
                    <td>
                      <b>{t.txn_no}</b>
                    </td>
                    <td>{formatTime(t.created_at, dateOpts)}</td>
                    <td className="items">{t.items.map((i) => `${i.quantity}× ${i.product_name}`).join(', ')}</td>
                    <td>{paymentLabel(t.payment_method)}</td>
                    <td className="num">{money(t.total)}</td>
                    <td>
                      <TxnStatusBadge status={t.status} voidRequest={t.void_request} />
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button type="button" className="btn sm" onClick={() => setView(t)}>
                        Receipt
                      </button>{' '}
                      {canVoid && (
                        <button type="button" className="btn sm danger-o" onClick={() => setVoidFor(t)}>
                          Request void
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {view && <ReceiptModal receipt={view} onClose={() => setView(null)} />}
      {voidFor && (
        <ReasonDialog
          title={`Request void · ${voidFor.txn_no}`}
          intro={
            <p>
              {voidFor.items.map((i) => `${i.quantity}× ${i.product_name}`).join(', ')} — <b>{money(voidFor.total)}</b>
              <br />
              <span className="muted">
                The sale stays in the records. If the admin approves, it is marked VOIDED and the items go back into stock.
              </span>
            </p>
          }
          label="What went wrong?"
          placeholder="e.g. Rang 3 phone charms instead of 2"
          confirmLabel="Send request"
          onClose={() => setVoidFor(null)}
          onSubmit={async (reason) => {
            await requestVoid(voidFor.id, reason);
            toast.ok('Void request sent to the admin');
            setVoidFor(null);
            reload({ silent: true });
          }}
        />
      )}
    </div>
  );
}
