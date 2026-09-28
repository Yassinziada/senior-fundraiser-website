import { useCallback, useState } from 'react';
import { useSettings } from '../../context/SettingsContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { useRealtime } from '../../hooks/useRealtime.js';
import { cashSummary, fetchHandovers, recordHandover } from '../../services/admin.js';
import { SectionFilter } from '../../components/Filters.jsx';
import { ErrorNotice, Spinner, Badge } from '../../components/ui.jsx';
import { dateInTz, formatDateTime } from '../../utils/dates.js';
import { centsToAmount, parseAmountInput, toCents } from '../../utils/money.js';
import { sectionLabel } from '../../utils/format.js';
import { exportCSV } from '../../utils/csv.js';

/**
 * End-of-day cash handover (no opening float). For each cashier/section:
 *   Expected physical cash = CASH sales of the day − CASH sales voided that day
 *   Difference             = Actual counted − Expected
 * Telda and InstaPay are shown but are never part of the cash box.
 * All expected figures are computed by the database.
 */
export default function CashHandoverPage() {
  const { money, tz, sections, dateOpts } = useSettings();
  const [date, setDate] = useState(() => dateInTz(tz));
  const [section, setSection] = useState('');
  const loader = useCallback(() => cashSummary(date, section || null), [date, section]);
  const { data, error, loading, reload } = useAsync(loader, [loader]);
  useRealtime(['transactions', 'void_requests', 'cash_handovers'], () => reload({ silent: true }));
  const rows = data ?? [];

  const totals = (list) => {
    const s = (k) => centsToAmount(list.reduce((a, r) => a + toCents(r[k]), 0));
    const counted = list.filter((r) => r.handover);
    return {
      cash_sales: s('cash_sales'),
      cash_refunds: s('cash_refunds'),
      expected_cash: s('expected_cash'),
      telda_sales: s('telda_sales'),
      instapay_sales: s('instapay_sales'),
      actual: centsToAmount(counted.reduce((a, r) => a + toCents(r.handover.actual_cash), 0)),
      difference: centsToAmount(counted.reduce((a, r) => a + toCents(r.handover.difference), 0)),
      counted: counted.length,
      n: list.length,
    };
  };
  const groups = [...sections.filter((s) => !section || s.code === section).map((s) => ({ key: s.code, label: s.name, rows: rows.filter((r) => r.section_code === s.code) }))];
  const all = totals(rows);

  const doExport = () =>
    exportCSV(`cash_handover_${date}`, rows, [
      { key: 'section_code', label: 'Section' },
      { key: 'cashier_name', label: 'Cashier' },
      { key: 'transaction_count', label: 'Sales' },
      { key: 'cash_sales', label: 'Cash sales' },
      { key: 'cash_refunds', label: 'Cash refunds (voids)' },
      { key: 'expected_cash', label: 'Expected physical cash' },
      { key: 'telda_sales', label: 'Telda' },
      { key: 'instapay_sales', label: 'InstaPay' },
      { key: 'actual', label: 'Actual counted', value: (r) => r.handover?.actual_cash ?? '' },
      { key: 'difference', label: 'Difference', value: (r) => r.handover?.difference ?? '' },
      { key: 'notes', label: 'Notes', value: (r) => r.handover?.notes ?? '' },
      { key: 'recorded_at', label: 'Recorded at', value: (r) => (r.handover ? formatDateTime(r.handover.recorded_at, dateOpts) : '') },
    ]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>End-of-day cash handover</h1>
          <p>Count each cashier&apos;s cash box and enter the amount. Telda and InstaPay are not part of the physical cash.</p>
        </div>
        <div className="actions">
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Business date" />
          <SectionFilter value={section} onChange={setSection} />
          <button type="button" className="btn" onClick={doExport}>
            Export CSV
          </button>
        </div>
      </div>
      <ErrorNotice error={error} onRetry={reload} />
      {loading && !data ? (
        <Spinner />
      ) : (
        <>
          {groups.map((g) => (
            <div key={g.key} style={{ marginBottom: 22 }}>
              <div className="sec-t">{g.label}</div>
              <HandoverTable rows={g.rows} date={date} onSaved={() => reload({ silent: true })} totals={totals(g.rows)} />
            </div>
          ))}
          {!section && (
            <div className="card">
              <h3>Combined ({sections.map((s) => s.name).join(' + ')})</h3>
              <table className="sumtbl">
                <tbody>
                  <tr>
                    <td>Cash sales</td>
                    <td>{money(all.cash_sales)}</td>
                  </tr>
                  <tr>
                    <td>Cash refunds (approved voids)</td>
                    <td>− {money(all.cash_refunds)}</td>
                  </tr>
                  <tr className="tot">
                    <td>Expected physical cash</td>
                    <td>{money(all.expected_cash)}</td>
                  </tr>
                  <tr>
                    <td>Actual counted ({all.counted} of {all.n} boxes)</td>
                    <td>{money(all.actual)}</td>
                  </tr>
                  <tr>
                    <td>Difference (counted boxes)</td>
                    <td className={all.difference < 0 ? 'bad-t' : all.difference > 0 ? 'warn-t' : 'ok-t'}>{money(all.difference)}</td>
                  </tr>
                  <tr>
                    <td>Telda (not in cash box)</td>
                    <td>{money(all.telda_sales)}</td>
                  </tr>
                  <tr>
                    <td>InstaPay (not in cash box)</td>
                    <td>{money(all.instapay_sales)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          <HandoverHistory date={date} section={section} />
        </>
      )}
    </div>
  );
}

function HandoverTable({ rows, date, onSaved, totals }) {
  const { money } = useSettings();
  if (!rows.length) return <div className="empty">No sales or handovers for this section on {date}.</div>;
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Cashier</th>
            <th className="num">Sales</th>
            <th className="num">Cash sales</th>
            <th className="num">Cash refunds</th>
            <th className="num">Expected cash</th>
            <th className="num">Telda</th>
            <th className="num">InstaPay</th>
            <th>Actual counted</th>
            <th className="num">Difference</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <HandoverRow key={`${r.section_code}:${r.cashier_id}`} r={r} date={date} onSaved={onSaved} />
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Section total</td>
            <td />
            <td className="num">{money(totals.cash_sales)}</td>
            <td className="num">{money(totals.cash_refunds)}</td>
            <td className="num">{money(totals.expected_cash)}</td>
            <td className="num">{money(totals.telda_sales)}</td>
            <td className="num">{money(totals.instapay_sales)}</td>
            <td>{money(totals.actual)}</td>
            <td className="num">{money(totals.difference)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function HandoverRow({ r, date, onSaved }) {
  const { money } = useSettings();
  const toast = useToast();
  const [actual, setActual] = useState(r.handover ? String(r.handover.actual_cash) : '');
  const [notes, setNotes] = useState(r.handover?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const actualC = parseAmountInput(actual);
  const diffPreview = Number.isNaN(actualC) ? null : centsToAmount(actualC - toCents(r.expected_cash));
  const stale = r.handover && toCents(r.handover.expected_cash) !== toCents(r.expected_cash);

  const save = async () => {
    if (Number.isNaN(actualC)) return toast.error('Enter the counted cash, e.g. 1250 or 1250.50');
    setBusy(true);
    try {
      await recordHandover(date, r.section_code, r.cashier_id, centsToAmount(actualC), notes);
      toast.ok(`Handover recorded for ${r.cashier_name}`);
      onSaved();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr>
      <td>
        <b>{r.cashier_name}</b>
        {r.handover && (
          <div className="small">
            <Badge tone="ok">RECORDED</Badge>
            {stale && (
              <>
                {' '}
                <Badge tone="warn">SALES CHANGED SINCE — RE-RECORD</Badge>
              </>
            )}
          </div>
        )}
      </td>
      <td className="num">{r.transaction_count}</td>
      <td className="num">{money(r.cash_sales)}</td>
      <td className="num">{r.cash_refunds ? `− ${money(r.cash_refunds)}` : money(0)}</td>
      <td className="num">
        <b>{money(r.expected_cash)}</b>
      </td>
      <td className="num">{money(r.telda_sales)}</td>
      <td className="num">{money(r.instapay_sales)}</td>
      <td>
        <input className="cell-in" inputMode="decimal" value={actual} onChange={(e) => setActual(e.target.value)} placeholder="0.00" aria-label="Actual counted cash" />
        <input className="input small-in" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Note (optional)" maxLength={500} />
      </td>
      <td className={`num ${diffPreview < 0 ? 'bad-t' : diffPreview > 0 ? 'warn-t' : 'ok-t'}`}>{diffPreview === null ? '—' : money(diffPreview)}</td>
      <td>
        <button type="button" className="btn sm primary" onClick={save} disabled={busy || Number.isNaN(actualC)}>
          {r.handover ? 'Re-record' : 'Record'}
        </button>
      </td>
    </tr>
  );
}

function HandoverHistory({ date, section }) {
  const { money, sections, dateOpts } = useSettings();
  const { data } = useAsync(() => fetchHandovers({ from: date, to: date, section: section || null, includeSuperseded: true }), [date, section]);
  const rows = data ?? [];
  if (!rows.length) return null;
  return (
    <details className="card" style={{ marginTop: 16 }}>
      <summary>
        <b>Recorded handovers for {date}</b> (including corrected ones)
      </summary>
      <table className="tbl" style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th>Recorded</th>
            <th>Section</th>
            <th>Cashier</th>
            <th className="num">Expected</th>
            <th className="num">Actual</th>
            <th className="num">Difference</th>
            <th>Notes</th>
            <th>By</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((h) => (
            <tr key={h.id} className={h.superseded_at ? 'dim' : ''}>
              <td>{formatDateTime(h.recorded_at, dateOpts)}</td>
              <td>{sectionLabel(h.section_code, sections)}</td>
              <td>{h.cashier?.full_name || h.cashier?.username}</td>
              <td className="num">{money(h.expected_cash)}</td>
              <td className="num">{money(h.actual_cash)}</td>
              <td className="num">{money(h.difference)}</td>
              <td>{h.notes}</td>
              <td>{h.recorder?.full_name || h.recorder?.username}</td>
              <td>{h.superseded_at ? <Badge>CORRECTED</Badge> : <Badge tone="ok">CURRENT</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
