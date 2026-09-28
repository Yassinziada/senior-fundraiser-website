import { createPortal } from 'react-dom';
import { useSettings } from '../context/SettingsContext.jsx';
import { formatDateTime } from '../utils/dates.js';
import { paymentLabel } from '../utils/format.js';

/** Customer receipt. Contains only customer-safe data (no cost/profit). */
export function Receipt({ receipt }) {
  const { settings, money, dateOpts } = useSettings();
  if (!receipt) return null;
  const voided = receipt.status === 'voided';
  return (
    <div className="receipt">
      <div className="r-head">
        <div className="r-event">{settings.event_name}</div>
        {settings.receipt_header && <div className="r-note">{settings.receipt_header}</div>}
        <div className="r-section">{receipt.section_name ?? receipt.section_code}</div>
      </div>
      {voided && <div className="r-void">VOIDED — NOT A VALID SALE</div>}
      <div className="r-meta">
        <div>
          <span>Receipt</span>
          <b>{receipt.txn_no}</b>
        </div>
        <div>
          <span>Date</span>
          <b>{formatDateTime(receipt.created_at, dateOpts)}</b>
        </div>
        {settings.receipt_show_cashier && receipt.cashier_name && (
          <div>
            <span>Cashier</span>
            <b>{receipt.cashier_name}</b>
          </div>
        )}
      </div>
      <table className="r-items">
        <thead>
          <tr>
            <th>Item</th>
            <th className="num">Qty</th>
            <th className="num">Price</th>
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {(receipt.items ?? []).map((i) => (
            <tr key={i.product_id}>
              <td>{i.product_name}</td>
              <td className="num">{i.quantity}</td>
              <td className="num">{money(i.unit_price)}</td>
              <td className="num">{money(i.line_total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="r-total">
        <span>TOTAL</span>
        <b>{money(receipt.total)}</b>
      </div>
      <div className="r-pay">
        <div>
          <span>Payment</span>
          <b>{paymentLabel(receipt.payment_method)}</b>
        </div>
        {receipt.payment_method === 'CASH' && (
          <>
            <div>
              <span>Amount received</span>
              <b>{money(receipt.amount_received)}</b>
            </div>
            <div>
              <span>Change</span>
              <b>{money(receipt.change_given)}</b>
            </div>
          </>
        )}
      </div>
      {settings.receipt_footer && <div className="r-foot">{settings.receipt_footer}</div>}
    </div>
  );
}

/**
 * Renders its children into a dedicated element that is the ONLY thing
 * visible when printing (see styles/print.css), so "Print / Save PDF" prints
 * just the receipt, never the POS screen.
 */
export function PrintArea({ children }) {
  return createPortal(<div className="print-area">{children}</div>, document.body);
}
