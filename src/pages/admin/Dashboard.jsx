import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSettings } from '../../context/SettingsContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { useRealtime } from '../../hooks/useRealtime.js';
import { salesReport, inventorySummary, fetchHandovers } from '../../services/admin.js';
import { SectionFilter, DateRangeFilter, initialRange } from '../../components/Filters.jsx';
import { BarList, ColumnChart, ErrorNotice, Spinner, StatCard } from '../../components/ui.jsx';
import { int, pct, paymentLabel, sectionLabel } from '../../utils/format.js';
import { toCents, centsToAmount } from '../../utils/money.js';

export default function Dashboard({ pendingVoids }) {
  const { isAdmin } = useAuth();
  const { money, tz, sections } = useSettings();
  const [section, setSection] = useState('');
  const [range, setRange] = useState(() => initialRange('today', tz));

  const loader = useCallback(async () => {
    const [report, inv, handovers] = await Promise.all([
      salesReport(range.from, range.to, section || null),
      inventorySummary(section || null),
      fetchHandovers({ from: range.from, to: range.to, section: section || null }),
    ]);
    return { report, inv, handovers };
  }, [range.from, range.to, section]);
  const { data, error, loading, reload } = useAsync(loader, [loader]);
  // live refresh when any device sells / voids / changes stock
  useRealtime(['transactions', 'products', 'void_requests', 'cash_handovers'], () => reload({ silent: true }));

  const t = data?.report?.totals;
  const inv = data?.inv;
  const bySection = Object.fromEntries((data?.report?.by_section ?? []).map((s) => [s.section_code, s]));
  const cashDiff = centsToAmount((data?.handovers ?? []).reduce((a, h) => a + toCents(h.difference), 0));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>Sales figures exclude voided transactions. Updates live.</p>
        </div>
        <div className="actions">
          <SectionFilter value={section} onChange={setSection} />
          <DateRangeFilter value={range} onChange={setRange} />
        </div>
      </div>
      <ErrorNotice error={error} onRetry={reload} />
      {pendingVoids > 0 && (
        <div className="notice warn">
          <b>
            {pendingVoids} void request{pendingVoids === 1 ? '' : 's'} waiting for approval.
          </b>{' '}
          <Link className="btn sm" to="/admin/voids">
            Review
          </Link>
        </div>
      )}
      {loading && !data ? (
        <Spinner />
      ) : t ? (
        <>
          <div className="sec-t">Sales</div>
          <div className="kpis">
            <StatCard label="Revenue" value={money(t.revenue)} sub={`${int(t.transactions)} transactions`} />
            {sections
              .filter((s) => !section || s.code === section)
              .map((s) => (
                <StatCard key={s.code} label={`${s.name} revenue`} value={money(bySection[s.code]?.revenue ?? 0)} sub={`${int(bySection[s.code]?.transactions ?? 0)} transactions`} />
              ))}
            <StatCard label="Units sold" value={int(t.units)} sub={`Avg. sale ${money(t.avg_transaction)}`} />
          </div>
          <div className="kpis">
            <StatCard label="Cash" value={money(t.cash)} />
            <StatCard label="Telda" value={money(t.telda)} />
            {Number(t.instapay) !== 0 && <StatCard label="InstaPay (historical)" value={money(t.instapay)} />}
            <StatCard label="Voids / refunds" value={money(t.voided_amount)} sub={`${int(t.voided_count)} voided`} tone={t.voided_count ? 'warn' : undefined} />
          </div>
          <div className="sec-t">Profit (estimated from recorded unit costs)</div>
          <div className="kpis">
            <StatCard estimate label="Cost of goods sold" value={money(t.cogs)} />
            <StatCard estimate label="Gross profit" value={money(t.gross_profit)} sub={`Margin ${pct(t.margin_pct)}`} />
            {isAdmin && <StatCard label="Pending voids" value={int(pendingVoids)} tone={pendingVoids ? 'warn' : undefined} />}
            <StatCard
              label="Cash differences"
              value={money(cashDiff)}
              sub={`${data.handovers.length} handover${data.handovers.length === 1 ? '' : 's'} recorded`}
              tone={cashDiff !== 0 ? 'bad' : undefined}
            />
          </div>

          <div className="grid2">
            <div className="card">
              <h3>Revenue by payment method</h3>
              <BarList
                format={money}
                rows={[
                  { key: 'CASH', label: paymentLabel('CASH'), value: t.cash },
                  { key: 'TELDA', label: paymentLabel('TELDA'), value: t.telda },
                  ...(Number(t.instapay) !== 0 ? [{ key: 'INSTAPAY', label: paymentLabel('INSTAPAY'), value: t.instapay }] : []),
                ]}
              />
            </div>
            <div className="card">
              <h3>Sales by hour</h3>
              <ColumnChart
                format={money}
                rows={(data.report.by_hour ?? []).map((h) => ({ key: h.hour, label: `${String(h.hour).padStart(2, '0')}h`, value: h.revenue }))}
              />
            </div>
            <div className="card">
              <h3>Top products (revenue)</h3>
              <BarList
                format={money}
                empty="No sales in this period."
                rows={(data.report.by_product ?? []).slice(0, 10).map((p) => ({ key: p.product_id, label: p.product_name, value: p.revenue }))}
              />
            </div>
            <div className="card">
              <h3>Stock</h3>
              <table className="sumtbl">
                <tbody>
                  <tr>
                    <td>Units remaining</td>
                    <td>{int(inv.units_in_stock)}</td>
                  </tr>
                  <tr>
                    <td>Stock value at cost (est.)</td>
                    <td>{money(inv.stock_cost_value)}</td>
                  </tr>
                  <tr>
                    <td>Stock value at selling price</td>
                    <td>{money(inv.stock_retail_value)}</td>
                  </tr>
                  <tr>
                    <td>Low-stock products</td>
                    <td className={inv.low_stock.length ? 'warn-t' : ''}>{inv.low_stock.length}</td>
                  </tr>
                  <tr>
                    <td>Out-of-stock products</td>
                    <td className={inv.out_of_stock.length ? 'bad-t' : ''}>{inv.out_of_stock.length}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {(inv.out_of_stock.length > 0 || inv.low_stock.length > 0) && (
            <div className="card" style={{ marginTop: 16 }}>
              <h3>Needs attention</h3>
              <ul className="att-list">
                {inv.out_of_stock.map((p) => (
                  <li key={p.id}>
                    <span>
                      {p.name} <span className="muted">· {sectionLabel(p.section_code, sections)}</span>
                    </span>
                    <span className="badge bad">OUT OF STOCK</span>
                  </li>
                ))}
                {inv.low_stock.map((p) => (
                  <li key={p.id}>
                    <span>
                      {p.name} <span className="muted">· {sectionLabel(p.section_code, sections)}</span>
                    </span>
                    <span className="badge warn">
                      {p.stock} left (min {p.min_stock})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
