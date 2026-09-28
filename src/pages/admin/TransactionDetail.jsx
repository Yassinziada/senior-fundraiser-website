import { useState } from 'react';
import Modal from '../../components/Modal.jsx';
import ReasonDialog from '../../components/ReasonDialog.jsx';
import { Receipt, PrintArea } from '../../components/Receipt.jsx';
import { ErrorNotice, Spinner, TxnStatusBadge } from '../../components/ui.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { useSettings } from '../../context/SettingsContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { fetchTransactionDetail, voidTransaction } from '../../services/admin.js';
import { formatDateTime } from '../../utils/dates.js';
import { paymentLabel, sectionLabel } from '../../utils/format.js';

const who = (p) => (p ? p.full_name || p.username : '—');

/** Build the customer receipt shape from admin table rows. */
export function toReceipt(t, sections) {
  return {
    ...t,
    section_name: sectionLabel(t.section_code, sections),
    cashier_name: who(t.cashier),
    items: (t.items ?? []).map((i) => ({ product_id: i.product_id, product_name: i.product_name, quantity: i.quantity, unit_price: i.unit_price, line_total: i.line_total })),
  };
}

export default function TransactionDetail({ id, onClose, onChanged }) {
  const { money, sections, dateOpts } = useSettings();
  const toast = useToast();
  const { data: t, error, loading, reload } = useAsync(() => fetchTransactionDetail(id), [id]);
  const [showReceipt, setShowReceipt] = useState(false);
  const [voiding, setVoiding] = useState(false);

  return (
    <Modal title={t ? `Transaction ${t.txn_no}` : 'Transaction'} onClose={onClose} wide>
      <ErrorNotice error={error} onRetry={reload} />
      {loading && !t ? (
        <Spinner />
      ) : t ? (
        <>
          <div className="detail-grid">
            <div>
              <span>Status</span>
              <TxnStatusBadge status={t.status} voidRequest={t.void_requests?.[0]} />
            </div>
            <div>
              <span>Section</span>
              <b>{sectionLabel(t.section_code, sections)}</b>
            </div>
            <div>
              <span>Cashier</span>
              <b>{who(t.cashier)}</b>
            </div>
            <div>
              <span>Date/time</span>
              <b>{formatDateTime(t.created_at, dateOpts)}</b>
            </div>
            <div>
              <span>Payment</span>
              <b>{paymentLabel(t.payment_method)}</b>
            </div>
            {t.payment_method === 'CASH' && (
              <div>
                <span>Received / change</span>
                <b>
                  {money(t.amount_received)} / {money(t.change_given)}
                </b>
              </div>
            )}
          </div>
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Qty</th>
                  <th className="num">Unit price</th>
                  <th className="num">Unit cost</th>
                  <th className="num">Line total</th>
                  <th className="num">Profit</th>
                </tr>
              </thead>
              <tbody>
                {t.items.map((i) => (
                  <tr key={i.id}>
                    <td>
                      {i.product_name}
                      {i.category_name && <div className="muted small">{i.category_name}</div>}
                    </td>
                    <td className="num">{i.quantity}</td>
                    <td className="num">{money(i.unit_price)}</td>
                    <td className="num">{money(i.unit_cost)}</td>
                    <td className="num">{money(i.line_total)}</td>
                    <td className="num">{money(Number(i.line_total) - Number(i.line_cost))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td className="num">{t.item_count}</td>
                  <td />
                  <td />
                  <td className="num">{money(t.total)}</td>
                  <td className="num">{money(Number(t.total) - Number(t.total_cost))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="muted small">Prices and costs shown are the values recorded at the time of sale.</p>

          {t.void_requests?.length > 0 && (
            <>
              <h3 style={{ marginTop: 16 }}>Void history</h3>
              <ul className="att-list">
                {t.void_requests.map((v) => (
                  <li key={v.id}>
                    <span>
                      <b>{v.status.toUpperCase()}</b> · requested by {who(v.requester)} {formatDateTime(v.requested_at, dateOpts)}: “{v.reason}”
                      {v.decided_at && (
                        <>
                          {' '}
                          · decided by {who(v.decider)} {formatDateTime(v.decided_at, dateOpts)}
                          {v.decision_note ? ` (“${v.decision_note}”)` : ''}
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="actions" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
            {t.status === 'completed' && !t.void_requests?.some((v) => v.status === 'pending') && (
              <button type="button" className="btn danger-o" onClick={() => setVoiding(true)}>
                Void this sale
              </button>
            )}
            <button type="button" className="btn" onClick={() => setShowReceipt(true)}>
              View receipt
            </button>
            <button type="button" className="btn primary" onClick={() => window.print()}>
              🖨 Print / Save PDF
            </button>
          </div>
          {showReceipt && (
            <div className="receipt-screen" style={{ marginTop: 16 }}>
              <Receipt receipt={toReceipt(t, sections)} />
            </div>
          )}
          <PrintArea>
            <Receipt receipt={toReceipt(t, sections)} />
          </PrintArea>
        </>
      ) : null}
      {voiding && (
        <ReasonDialog
          title={`Void ${t.txn_no}`}
          intro={
            <p>
              This marks the sale as VOIDED, records a refund of <b>{money(t.total)}</b> ({paymentLabel(t.payment_method)}) and puts the items back
              into stock. Nothing is deleted.
            </p>
          }
          confirmLabel="Void sale"
          danger
          onClose={() => setVoiding(false)}
          onSubmit={async (reason) => {
            await voidTransaction(t.id, reason);
            toast.ok(`${t.txn_no} voided`);
            setVoiding(false);
            reload();
            onChanged?.();
          }}
        />
      )}
    </Modal>
  );
}
