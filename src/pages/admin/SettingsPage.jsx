import { useEffect, useState } from 'react';
import { useSettings } from '../../context/SettingsContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { updateSettings } from '../../services/admin.js';
import { createMoneyFormatter } from '../../utils/money.js';

/**
 * Only safe, non-secret settings live here. Database/API credentials are
 * never stored in or shown by the app.
 */
export default function SettingsPage() {
  const { settings, reload } = useSettings();
  const toast = useToast();
  const [f, setF] = useState(settings);
  const [busy, setBusy] = useState(false);
  useEffect(() => setF(settings), [settings]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const preview = createMoneyFormatter(f)(1234.5);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await updateSettings({
        event_name: f.event_name,
        currency_code: f.currency_code,
        locale: f.locale,
        timezone: f.timezone,
        low_stock_default: parseInt(f.low_stock_default, 10) || 0,
        receipt_header: f.receipt_header,
        receipt_footer: f.receipt_footer,
        receipt_show_cashier: f.receipt_show_cashier,
      });
      await reload();
      toast.ok('Settings saved');
    } catch (x) {
      toast.error(x.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Changes apply to every device (they may need a page refresh).</p>
        </div>
      </div>
      <form className="card" onSubmit={save} style={{ maxWidth: 760 }}>
        <label className="f">
          Event / Bazaar name
          <input className="input" value={f.event_name} onChange={set('event_name')} maxLength={120} />
        </label>
        <div className="frow">
          <label className="f">
            Currency code
            <input className="input" value={f.currency_code} onChange={set('currency_code')} maxLength={3} />
            <small>3-letter ISO code, e.g. EGP, USD, EUR.</small>
          </label>
          <label className="f">
            Number format (locale)
            <input className="input" value={f.locale} onChange={set('locale')} />
            <small>e.g. en-EG, ar-EG, en-US. Preview: {preview}</small>
          </label>
        </div>
        <div className="frow">
          <label className="f">
            Timezone
            <input className="input" value={f.timezone} onChange={set('timezone')} />
            <small>Decides which day a sale belongs to. e.g. Africa/Cairo</small>
          </label>
          <label className="f">
            Default minimum stock for new products
            <input className="input" inputMode="numeric" value={f.low_stock_default} onChange={set('low_stock_default')} />
          </label>
        </div>
        <label className="f">
          Receipt header (optional)
          <input className="input" value={f.receipt_header} onChange={set('receipt_header')} maxLength={300} placeholder="e.g. Grade 12 Senior Fundraiser" />
        </label>
        <label className="f">
          Receipt footer
          <input className="input" value={f.receipt_footer} onChange={set('receipt_footer')} maxLength={300} />
        </label>
        <label className="chk" style={{ marginBottom: 14 }}>
          <input type="checkbox" checked={!!f.receipt_show_cashier} onChange={set('receipt_show_cashier')} /> Show cashier name on receipts
        </label>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
      </form>
      <div className="card" style={{ maxWidth: 760, marginTop: 16 }}>
        <h3>Backups</h3>
        <p className="muted">
          All data lives in your Supabase database, not in this browser. Use the <b>Export CSV</b> buttons on Sales, Products, Reports, Stock log and
          Audit log for spreadsheets, and see the README section “Backup” for full database backups.
        </p>
      </div>
    </div>
  );
}
