import { useState } from 'react';
import Modal from '../../components/Modal.jsx';
import { useMoneyAction } from '../../hooks/useMoneyAction.js';
import { stockMoneyArgs } from '../../services/money.js';
import MoneyFields from '../../components/MoneyFields.jsx';
import { parseAmountInput, centsToAmount } from '../../utils/money.js';

const MODES = [
  { id: 'add', label: 'Add stock', help: 'e.g. new delivery' },
  { id: 'remove', label: 'Remove stock', help: 'e.g. damaged, lost, taken back' },
  { id: 'set', label: 'Set counted stock', help: 'after a physical count; the difference is recorded' },
];

export default function StockAdjustModal({ product, onClose, onSaved }) {
  const [mode, setMode] = useState('add');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const { busy, error, pending, send } = useMoneyAction(`stock.${product.id}`);
  const [cost, setCost] = useState(String(product.cost ?? ''));
  const [account, setAccount] = useState('CASH');
  const [noSpend, setNoSpend] = useState(false);
  const free = mode !== 'add' || noSpend;
  const costCents = parseAmountInput(cost);
  const n = /^\d+$/.test(qty.trim()) ? parseInt(qty, 10) : NaN;
  const after = Number.isNaN(n) ? null : mode === 'add' ? product.stock + n : mode === 'remove' ? product.stock - n : n;
  const valid = !Number.isNaN(n) && (mode === 'set' || n > 0) && after >= 0 && reason.trim().length >= 3 && after !== product.stock && (free || Number.isFinite(costCents));

  const submit = async (e) => {
    e?.preventDefault();
    if (busy || (!pending && !valid)) return;
    const request = pending || { fn: 'money_stock', args: stockMoneyArgs({ key: crypto.randomUUID(), product: product.id, mode,
      quantity: n, reason: reason.trim(), unitCost: centsToAmount(costCents), account, noSpend: free }) };
    if (await send(request)) onSaved();
  };

  return (
    <Modal
      title={`Stock · ${product.name}`}
      onClose={onClose}
      closable={!busy}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={submit} disabled={(!valid && !pending) || busy}>
            {busy ? 'Saving…' : pending ? 'Retry safely' : 'Save adjustment'}
          </button>
        </>
      }
    >
      <form onSubmit={submit}>
        {pending && <div className="notice warn">An earlier stock change is unconfirmed. Retry safely to recover it without charging twice.</div>}
        <fieldset disabled={busy || !!pending} style={{ border: 0, padding: 0 }}>
        <p>
          Current stock: <b className="big-num">{product.stock}</b>
        </p>
        <div className="subtabs">
          {MODES.map((m) => (
            <button type="button" key={m.id} className={`subtab ${mode === m.id ? 'on' : ''}`} onClick={() => setMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <label className="f">
          {mode === 'set' ? 'Counted quantity' : 'Quantity'}
          <input className="input" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} autoFocus />
          <small>{MODES.find((m) => m.id === mode).help}</small>
        </label>
        <label className="f">
          Reason (required)
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. Second box delivered" />
        </label>
        {mode === 'add' && <>
          <label className="chk"><input type="checkbox" checked={noSpend} onChange={e => setNoSpend(e.target.checked)} />No money spent (donated or free stock)</label>
          {!noSpend && <MoneyFields cost={cost} setCost={setCost} account={account} setAccount={setAccount} quantity={n} />}
        </>}
        {mode !== 'add' && <p className="muted">Count corrections do not move money. Stock removed is recorded as a stock loss in net profit.</p>}
        {after !== null && (
          <div className={`notice ${after < 0 ? 'bad' : 'info'}`}>
            New stock will be <b>{after}</b>
            {after < 0 && ' — not possible'}.
          </div>
        )}
        </fieldset>
        {error && <div className="notice bad">{error}</div>}
      </form>
    </Modal>
  );
}
