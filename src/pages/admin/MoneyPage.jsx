import { useState } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import { useSettings } from '../../context/SettingsContext.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { useRealtime } from '../../hooks/useRealtime.js';
import { useMoneyAction } from '../../hooks/useMoneyAction.js';
import { moneySummary, moneyHistory } from '../../services/money.js';
import { AccountSelect } from '../../components/MoneyFields.jsx';
import { ErrorNotice, Spinner, StatCard } from '../../components/ui.jsx';
import { parseAmountInput, centsToAmount } from '../../utils/money.js';

export default function MoneyPage() {
  const { isAdmin } = useAuth();
  const { money } = useSettings();
  const { data, error, loading, reload } = useAsync(async () => ({ summary: await moneySummary(), history: await moneyHistory() }), []);
  useRealtime(['transactions'], () => reload({ silent: true }));
  const action = useMoneyAction('finance');
  const [opening, setOpening] = useState({ CASH: '', TELDA: '0', INSTAPAY: '0' });
  const [kind, setKind] = useState('expense');
  const [account, setAccount] = useState('CASH');
  const [to, setTo] = useState('TELDA');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const summary = data?.summary;
  const disabled = action.busy || !!action.pending;
  const submit = async (request) => {
    setMessage(null);
    if (await action.send(request)) {
      setAmount(''); setNote(''); setMessage('Saved.'); await reload({ silent: true });
    }
  };
  const start = e => {
    e.preventDefault();
    if (!confirmed || disabled) return;
    const values = Object.values(opening).map(parseAmountInput);
    if (values.some(n => !Number.isFinite(n))) return;
    submit({ fn: 'money_open', args: { p_key: crypto.randomUUID(), p_cash: centsToAmount(values[0]), p_telda: centsToAmount(values[1]), p_instapay: centsToAmount(values[2]) } });
  };
  return <div className="page">
    <div className="page-head"><div><h1>Money</h1><p>Cash, Telda and InstaPay together — with profit shown separately.</p></div><button className="btn" onClick={() => reload()}>Refresh</button></div>
    <ErrorNotice error={error} onRetry={reload} />
    {action.error && <div className="notice bad" role="alert">{action.error}</div>}
    {message && <div className="notice ok" role="status">{message}</div>}
    {action.pending && <div className="notice warn">The last action is unconfirmed. Retry it before entering another.<button className="btn" disabled={action.busy} onClick={() => submit(action.pending)}>Retry safely</button></div>}
    {loading && !data ? <Spinner /> : summary && !summary.started_at ? <div className="card">
      <h2>Starting money</h2>
      <p>Enter the money you actually have in each account now. Tracking starts when you save. Earlier sales and stock purchases are already reflected in these balances and will not be counted again.</p>
      {isAdmin ? <form onSubmit={start}><fieldset disabled={disabled} style={{ border: 0 }}>
        <div className="frow">{Object.entries(opening).map(([k, v]) => <label className="f" key={k}>{k === 'CASH' ? 'Starting Cash' : k === 'TELDA' ? 'Starting Telda' : 'Starting InstaPay'}<input className="input" type="number" min="0" step="0.01" required value={v} onChange={e => setOpening(o => ({ ...o, [k]: e.target.value }))} /></label>)}</div>
        <label className="chk"><input type="checkbox" required checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />These are the current balances. Record starting money once.</label>
        <button className="btn primary" disabled={!confirmed} type="submit">Start money tracking</button>
      </fieldset></form> : <p>Ask Admin to enter the starting money.</p>}
    </div> : summary && <>
      <p className="muted">Since {new Date(summary.started_at).toLocaleString()}. All sections combined. Refunds are subtracted from sales.</p>
      <div className="kpis"><StatCard label="Total available money" value={money(summary.total)} /><StatCard label="Cash" value={money(summary.cash)} /><StatCard label="Telda" value={money(summary.telda)} /><StatCard label="InstaPay" value={money(summary.instapay)} /></div>
      {[summary.cash, summary.telda, summary.instapay].some(n => n < 0) && <div className="notice warn">An account is negative after a refund. Reconcile its actual balance before recording more payments.</div>}
      <div className="kpis"><StatCard label="Total sales (after refunds)" value={money(summary.sales)} /><StatCard label="Gross profit" value={money(summary.gross_profit)} /><StatCard label="Net profit" value={money(summary.net_profit)} /></div>
      <div className="card"><h2>How the totals add up</h2>
        <p>Starting money {money(summary.starting)} + sales {money(summary.sales)} − stock purchases {money(summary.purchases)} − expenses {money(summary.expenses)} − refunds for earlier sales {money(summary.legacy_refunds)} = <b>{money(summary.total)}</b>.</p>
        <p>Gross profit = sales − cost of items sold ({money(summary.cogs)}). Net profit = gross profit − expenses − stock losses ({money(summary.stock_losses)}). Unsold purchases are not deducted from profit again.</p>
        <p className="muted">Cash includes money still held by cashiers. Cash handovers do not add it a second time. Transfers between accounts do not change the total.</p>
      </div>
      <form className="card" style={{ marginTop: 16 }} onSubmit={e => { e.preventDefault(); if (disabled) return; const cents = parseAmountInput(amount); if (!(cents > 0)) return;
        submit({ fn: 'money_record', args: { p_key: crypto.randomUUID(), p_kind: kind, p_account: account, p_amount: centsToAmount(cents), p_note: note.trim(), p_to: kind === 'transfer' ? to : null } }); }}>
        <h2>Record expense or transfer</h2><p>Stock payments are recorded when you receive stock. Do not enter them again as expenses.</p>
        <fieldset disabled={disabled} style={{ border: 0 }}><div className="frow">
          <label className="f">Type<select aria-label="Type" className="input" value={kind} onChange={e => setKind(e.target.value)}><option value="expense">Operating expense</option><option value="transfer">Transfer between accounts</option></select></label>
          <AccountSelect value={account} onChange={setAccount} />
          {kind === 'transfer' && <AccountSelect label="Transfer to" value={to} onChange={setTo} />}
          <label className="f">Amount<input className="input" type="number" min="0.01" step="0.01" required value={amount} onChange={e => setAmount(e.target.value)} /></label>
        </div><label className="f">Description<input className="input" required minLength={3} maxLength={500} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Transport to the school" /></label>
        <button className="btn primary" disabled={kind === 'transfer' && account === to}>Record {kind}</button></fieldset>
      </form>
      <div className="card" style={{ marginTop: 16 }}><h2>Recent money movements</h2><p className="muted">Latest 100 entries. Totals above include the full history.</p><div className="table-wrap"><table className="tbl"><thead><tr><th>Date</th><th>Type</th><th>Description</th><th>Account</th><th>Money change</th></tr></thead>
        <tbody>{data.history.map(row => <tr key={row.id}><td>{new Date(row.created_at).toLocaleString()}</td><td>{row.kind.replaceAll('_', ' ')}</td><td>{row.note}</td><td>{row.account}</td><td>{money(row.amount)}</td></tr>)}</tbody></table></div></div>
    </>}
  </div>;
}
