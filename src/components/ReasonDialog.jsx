import { useState } from 'react';
import Modal from './Modal.jsx';

/** Ask for a (usually mandatory) reason/note, then run onSubmit(text). */
export default function ReasonDialog({ title, intro, label = 'Reason', placeholder, required = true, confirmLabel = 'Submit', danger = false, onSubmit, onClose }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const valid = !required || text.trim().length >= 3;
  const submit = async (e) => {
    e?.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(text.trim());
    } catch (x) {
      setErr(x.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      closable={!busy}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} onClick={submit} disabled={!valid || busy}>
            {busy ? 'Please wait…' : confirmLabel}
          </button>
        </>
      }
    >
      <form onSubmit={submit}>
        {intro}
        <label className="f">
          {label}
          {required && <small>Required (at least 3 characters)</small>}
          <textarea className="input" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} autoFocus maxLength={500} />
        </label>
        {err && <div className="notice bad">{err}</div>}
      </form>
    </Modal>
  );
}
