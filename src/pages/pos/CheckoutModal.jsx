import { useMemo, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import { useSettings } from '../../context/SettingsContext.jsx';
import { useOnlineStatus } from '../../hooks/useOnlineStatus.js';
import { PAYMENT_METHODS } from '../../utils/format.js';
import { calcChange, centsToAmount, parseAmountInput } from '../../utils/money.js';

const QUICK = [10, 20, 50, 100, 200, 500];

/**
 * Payment step. It never decides that a sale succeeded on its own: success is
 * shown only after the database returns the saved transaction.
 * phase: 'form' | 'sending' | 'uncertain'
 */
export default function CheckoutModal({ totalCents, units, phase, error, initialMethod = 'CASH', initialReceived = '', onSubmit, onRetry, onCheckStatus, onClose }) {
  const { money, settings } = useSettings();
  const online = useOnlineStatus();
  const [method, setMethod] = useState(PAYMENT_METHODS.some(m => m.id === initialMethod) || phase === 'uncertain' ? initialMethod : 'CASH');
  const [received, setReceived] = useState(initialReceived);

  const receivedCents = parseAmountInput(received);
  const change = useMemo(() => calcChange(totalCents, receivedCents), [totalCents, receivedCents]);
  const isCash = method === 'CASH';
  const formValid = !isCash || change.valid;
  const busy = phase === 'sending';
  const uncertain = phase === 'uncertain';

  const addQuick = (v) => {
    const base = Number.isNaN(receivedCents) ? 0 : receivedCents;
    setReceived(String(centsToAmount(base + v * 100)));
  };

  const submit = (e) => {
    e?.preventDefault();
    if (busy || !formValid || !online) return;
    onSubmit({ method, received: isCash ? centsToAmount(receivedCents) : null, receivedText: received });
  };

  return (
    <Modal title={uncertain ? 'Sale not confirmed' : 'Payment'} onClose={onClose} closable={!busy && !uncertain}>
      <form className="paybox" onSubmit={submit}>
        <div className="pay-total">
          <span className="t-lbl">TOTAL · {units} item{units === 1 ? '' : 's'}</span>
          <b>{money(centsToAmount(totalCents))}</b>
        </div>

        {uncertain ? (
          <div className="notice warn" role="alert" style={{ marginTop: 14 }}>
            <b>We could not confirm whether this sale was saved</b> (the connection dropped or timed out).
            <br />
            Do <b>not</b> hand over goods or change yet. Press <b>Retry</b> when the connection is back — it is safe: the same sale
            can never be recorded twice. Or press <b>Check status</b> to find out if it was saved.
          </div>
        ) : (
          <>
            <div className="t-lbl" style={{ marginTop: 16 }}>
              PAYMENT METHOD
            </div>
            <div className="paymethods" role="radiogroup">
              {PAYMENT_METHODS.map((m) => (
                <button
                  type="button"
                  key={m.id}
                  role="radio"
                  aria-checked={method === m.id}
                  className={`paym ${method === m.id ? 'on' : ''}`}
                  onClick={() => setMethod(m.id)}
                  disabled={busy}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {isCash ? (
              <>
                <label className="t-lbl" htmlFor="received" style={{ display: 'block', marginTop: 14 }}>
                  AMOUNT RECEIVED ({settings.currency_code})
                </label>
                <input
                  id="received"
                  className="paid-in"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0"
                  value={received}
                  onChange={(e) => setReceived(e.target.value)}
                  disabled={busy}
                  autoFocus
                />
                <div className="quick">
                  <button type="button" className="exact" onClick={() => setReceived(String(centsToAmount(totalCents)))} disabled={busy}>
                    Exact
                  </button>
                  {QUICK.map((v) => (
                    <button type="button" key={v} onClick={() => addQuick(v)} disabled={busy}>
                      +{v}
                    </button>
                  ))}
                  <button type="button" onClick={() => setReceived('')} disabled={busy}>
                    Clear
                  </button>
                </div>
                <div className={`change-box ${change.valid ? '' : 'no'}`}>
                  <span className="t-lbl">CHANGE</span>
                  <span className="t-change">
                    {received.trim() === '' ? (
                      <span className="muted">Enter amount</span>
                    ) : Number.isNaN(receivedCents) ? (
                      <span className="bad-t">Invalid amount</span>
                    ) : !change.valid ? (
                      <span className="bad-t">Short by {money(centsToAmount(change.short))}</span>
                    ) : (
                      money(centsToAmount(change.change))
                    )}
                  </span>
                </div>
              </>
            ) : (
              <div className="notice info" style={{ marginTop: 14 }}>
                Confirm the customer&apos;s {method === 'TELDA' ? 'Telda' : 'InstaPay'} transfer of{' '}
                <b>{money(centsToAmount(totalCents))}</b> has arrived before completing the sale. No cash change is needed.
              </div>
            )}
          </>
        )}

        {error && !uncertain && (
          <div className="notice bad" role="alert" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}
        {!online && (
          <div className="notice bad" role="alert" style={{ marginTop: 12 }}>
            <b>Internet connection required to complete sale.</b>
          </div>
        )}

        {uncertain ? (
          <div className="pay-actions">
            <button type="button" className="btn" onClick={onCheckStatus} disabled={!online}>
              Check status
            </button>
            <button type="button" className="complete" onClick={onRetry} disabled={!online}>
              RETRY SAFELY
            </button>
          </div>
        ) : (
          <button type="submit" className="complete" disabled={busy || !formValid || !online}>
            {busy ? 'SAVING… please wait' : 'COMPLETE SALE'}
          </button>
        )}
      </form>
    </Modal>
  );
}
