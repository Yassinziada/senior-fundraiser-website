import { useSettings } from '../../context/SettingsContext.jsx';
import { centsToAmount, toCents } from '../../utils/money.js';

export default function CartPanel({ cart, totalCents, units, locked, onInc, onDec, onRemove, onClear, onPay, canPay, payHint, mobileOpen, onCloseMobile }) {
  const { money } = useSettings();
  return (
    <aside className={`cart ${mobileOpen ? 'open' : ''}`} aria-label="Cart">
      <div className="cart-h">
        <b>Order</b>
        <div className="actions">
          <button type="button" className="btn sm" onClick={onClear} disabled={!cart.length || locked}>
            Clear
          </button>
          <button type="button" className="btn sm mobile-only" onClick={onCloseMobile}>
            Back to products
          </button>
        </div>
      </div>
      <div className="lines">
        {cart.length === 0 ? (
          <div className="empty">
            <span className="big">🛍️</span>Tap a product to add it to the order.
          </div>
        ) : (
          cart.map((l) => (
            <div className="line" key={l.product_id}>
              <div>
                <div className="l-name">{l.name}</div>
                <div className="l-each">{money(l.price)} each</div>
              </div>
              <div className="l-sub">{money(centsToAmount(toCents(l.price) * l.quantity))}</div>
              <div className="qty">
                <button type="button" onClick={() => onDec(l.product_id)} aria-label={`One less ${l.name}`} disabled={locked}>
                  −
                </button>
                <span>{l.quantity}</span>
                <button type="button" onClick={() => onInc(l.product_id)} aria-label={`One more ${l.name}`} disabled={locked}>
                  +
                </button>
              </div>
              <div style={{ textAlign: 'right' }}>
                <button type="button" className="icon-btn" onClick={() => onRemove(l.product_id)} disabled={locked}>
                  ✕ Remove
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="order-foot">
        <div className="t-row">
          <span className="t-lbl">TOTAL</span>
          <span className="t-total">{money(centsToAmount(totalCents))}</span>
        </div>
        <div className="muted" style={{ textAlign: 'right' }}>
          {units ? `${units} item${units === 1 ? '' : 's'}` : 'No items'}
        </div>
        <button type="button" className="complete" onClick={onPay} disabled={!canPay}>
          {units ? `CHECKOUT  ${money(centsToAmount(totalCents))}` : 'CHECKOUT'}
        </button>
        {payHint && <div className="pay-hint">{payHint}</div>}
      </div>
    </aside>
  );
}
