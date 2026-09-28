import { useState } from 'react';
import Modal from '../../components/Modal.jsx';
import { adjustStock } from '../../services/admin.js';

const MODES = [
  { id: 'add', label: 'Add stock', help: 'e.g. new delivery' },
  { id: 'remove', label: 'Remove stock', help: 'e.g. damaged, lost, taken back' },
  { id: 'set', label: 'Set counted stock', help: 'after a physical count; the difference is recorded' },
];

export default function StockAdjustModal({ product, onClose, onSaved }) {
  const [mode, setMode] = useState('add');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const n = /^\d+$/.test(qty.trim()) ? parseInt(qty, 10) : NaN;
  const after = Number.isNaN(n) ? null : mode === 'add' ? product.stock + n : mode === 'remove' ? product.stock - n : n;
  const valid = !Number.isNaN(n) && (mode === 'set' || n > 0) && after >= 0 && reason.trim().length >= 3 && after !== product.stock;

  const submit = async (e) => {
    e?.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await adjustStock(product.id, mode, n, reason.trim());
      onSaved();
    } catch (x) {
      setError(x.message);
      setBusy(false);
    }
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
          <button type="button" className="btn primary" onClick={submit} disabled={!valid || busy}>
            {busy ? 'Saving…' : 'Save adjustment'}
          </button>
        </>
      }
    >
      <form onSubmit={submit}>
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
        {after !== null && (
          <div className={`notice ${after < 0 ? 'bad' : 'info'}`}>
            New stock will be <b>{after}</b>
            {after < 0 && ' — not possible'}.
          </div>
        )}
        {error && <div className="notice bad">{error}</div>}
      </form>
    </Modal>
  );
}
