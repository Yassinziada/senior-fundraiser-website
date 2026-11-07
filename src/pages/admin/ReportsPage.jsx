import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSettings } from '../../context/SettingsContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { canOpenPage } from '../../utils/roles.js';
import { useAsync } from '../../hooks/useAsync.js';
import { fetchHandovers, fetchTransactions, inventorySummary, productsOverview, salesReport } from '../../services/admin.js';
import { SectionFilter, DateRangeFilter, initialRange } from '../../components/Filters.jsx';
import { ErrorNotice, Spinner, StatCard } from '../../components/ui.jsx';
import { formatDateTime } from '../../utils/dates.js';
import { int, pct, paymentLabel, sectionLabel } from '../../utils/format.js';
import { exportCSV } from '../../utils/csv.js';
import { stockStatus, STOCK_LABEL } from '../../utils/stock.js';

const TABS = [
  ['summary', 'Summary & daily'],
  ['payments', 'Payment methods'],
  ['products', 'By product'],
  ['categories', 'By category'],
  ['cashiers', 'By cashier'],
  ['inventory', 'Inventory'],
  ['voids', 'Voids / refunds'],
  ['cash', 'Cash reconciliation'],
];

/** A table + CSV export from the same column definitions. */
function ReportTable({ title, rows, columns, filename, footer }) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="page-head" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>{title}</h3>
        <button type="button" className="btn sm" onClick={() => exportCSV(filename, rows, columns.map((c) => ({ ...c, value: c.csv ?? c.value })))} disabled={!rows.length}>
          Export CSV
        </button>
      </div>
      <div className="table-wrap flat">
        <table className="tbl">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={c.num ? 'num' : ''}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                  No data for this period.
                </td>
              </tr>
            )}
            {rows.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.key} className={c.num ? 'num' : ''}>
                    {c.render ? c.render(r) : c.value ? c.value(r) : r[c.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {footer && rows.length > 0 && <tfoot>{footer}</tfoot>}
        </table>
      </div>
    </div>
  );
}

export default function ReportsPage() {
  const { profile } = useAuth();
  const { money, tz, sections, dateOpts } = useSettings();
  const [tab, setTab] = useState('summary');
  const [section, setSection] = useState('');
  const [range, setRange] = useState(() => initialRange('all', tz));

  const loader = useCallback(() => salesReport(range.from, range.to, section || null), [range.from, range.to, section]);
  const { data: r, error, loading, reload } = useAsync(loader, [loader]);
  const sec = (code) => sectionLabel(code, sections);
  const m = (k) => ({ key: k, num: true, render: (x) => money(x[k]), csv: (x) => x[k] });

  const t = r?.totals;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Reports</h1>
          <p>
            Revenue, COGS and profit use the price and cost recorded on each sale (historical values). Voided sales are excluded from revenue. Stock
            {canOpenPage(profile.role, 'stock') ? <>movements have their own page: <Link to="/admin/stock">Stock log</Link>.</> : 'movements are managed by the Product Manager.'}
          </p>
        </div>
      </div>
      <div className="toolbar">
        <SectionFilter value={section} onChange={setSection} />
        <DateRangeFilter value={range} onChange={setRange} />
      </div>
      <div className="subtabs">
        {TABS.map(([id, label]) => (
          <button type="button" key={id} className={`subtab ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <ErrorNotice error={error} onRetry={reload} />
      {loading && !r ? (
        <Spinner />
      ) : !r ? null : (
        <>
          {tab === 'summary' && (
            <>
              <div className="kpis">
                <StatCard label="Revenue" value={money(t.revenue)} sub={`${int(t.transactions)} sales · ${int(t.units)} units`} />
                <StatCard estimate label="COGS" value={money(t.cogs)} />
                <StatCard estimate label="Gross profit" value={money(t.gross_profit)} sub={`Margin ${pct(t.margin_pct)}`} />
                <StatCard label="Voided" value={money(t.voided_amount)} sub={`${int(t.voided_count)} sales`} />
              </div>
              <ReportTable
                title="Sales by section"
                filename="sales_by_section"
                rows={r.by_section}
                columns={[
                  { key: 'section_name', label: 'Section' },
                  { key: 'transactions', label: 'Sales', num: true },
                  { key: 'units', label: 'Units', num: true },
                  { ...m('revenue'), label: 'Revenue' },
                  { ...m('cash'), label: 'Cash' },
                  { ...m('telda'), label: 'Telda' },
                  { ...m('instapay'), label: 'InstaPay' },
                  { ...m('cogs'), label: 'COGS (est.)' },
                  { ...m('gross_profit'), label: 'Gross profit (est.)' },
                  { key: 'voided_count', label: 'Voided', num: true },
                  { ...m('voided_amount'), label: 'Voided amount' },
                ]}
              />
              <ReportTable
                title="Daily sales"
                filename="daily_sales"
                rows={r.by_day}
                columns={[
                  { key: 'business_date', label: 'Date' },
                  { key: 'section_code', label: 'Section', value: (x) => sec(x.section_code) },
                  { key: 'transactions', label: 'Sales', num: true },
                  { key: 'units', label: 'Units', num: true },
                  { ...m('revenue'), label: 'Revenue' },
                  { ...m('cash'), label: 'Cash' },
                  { ...m('telda'), label: 'Telda' },
                  { ...m('instapay'), label: 'InstaPay' },
                  { ...m('cogs'), label: 'COGS (est.)' },
                  { ...m('gross_profit'), label: 'Gross profit (est.)' },
                ]}
              />
            </>
          )}

          {tab === 'payments' && (
            <PaymentMatrix report={r} sections={sections} section={section} money={money} />
          )}

          {tab === 'products' && (
            <ReportTable
              title="Sales by product"
              filename="sales_by_product"
              rows={r.by_product}
              columns={[
                { key: 'product_name', label: 'Product' },
                { key: 'section_code', label: 'Section', value: (x) => sec(x.section_code) },
                { key: 'category_name', label: 'Category' },
                { key: 'units', label: 'Units', num: true },
                { ...m('revenue'), label: 'Revenue' },
                { ...m('cogs'), label: 'COGS (est.)' },
                { ...m('gross_profit'), label: 'Gross profit (est.)' },
                { key: 'margin', label: 'Margin', num: true, value: (x) => pct(x.revenue > 0 ? (x.gross_profit / x.revenue) * 100 : null) },
              ]}
            />
          )}

          {tab === 'categories' && (
            <ReportTable
              title="Sales by category"
              filename="sales_by_category"
              rows={r.by_category}
              columns={[
                { key: 'section_code', label: 'Section', value: (x) => sec(x.section_code) },
                { key: 'category_name', label: 'Category' },
                { key: 'units', label: 'Units', num: true },
                { ...m('revenue'), label: 'Revenue' },
                { ...m('cogs'), label: 'COGS (est.)' },
                { ...m('gross_profit'), label: 'Gross profit (est.)' },
              ]}
            />
          )}

          {tab === 'cashiers' && (
            <ReportTable
              title="Sales by cashier"
              filename="sales_by_cashier"
              rows={r.by_cashier}
              columns={[
                { key: 'cashier_name', label: 'Cashier' },
                { key: 'section_code', label: 'Section', value: (x) => sec(x.section_code) },
                { key: 'transactions', label: 'Sales', num: true },
                { ...m('revenue'), label: 'Revenue' },
                { ...m('cash'), label: 'Cash' },
                { ...m('telda'), label: 'Telda' },
                { ...m('instapay'), label: 'InstaPay' },
                { key: 'voided_count', label: 'Voided', num: true },
                { ...m('voided_amount'), label: 'Voided amount' },
              ]}
            />
          )}

          {tab === 'inventory' && <InventoryReport section={section} />}
          {tab === 'voids' && <VoidsReport range={range} section={section} dateOpts={dateOpts} />}
          {tab === 'cash' && <CashReport range={range} section={section} />}
        </>
      )}
    </div>
  );
}

function PaymentMatrix({ report, sections, section, money }) {
  const methods = ['CASH', 'TELDA', 'INSTAPAY'];
  const secs = sections.filter((s) => !section || s.code === section);
  const cell = (sc, pm) => report.by_payment.find((x) => x.section_code === sc && x.payment_method === pm);
  const rows = methods.map((pm) => {
    const row = { payment_method: paymentLabel(pm) };
    let total = 0;
    let n = 0;
    for (const s of secs) {
      const c = cell(s.code, pm);
      row[s.code] = c?.revenue ?? 0;
      row[`${s.code}_n`] = c?.transactions ?? 0;
      total += Math.round((c?.revenue ?? 0) * 100);
      n += c?.transactions ?? 0;
    }
    row.total = total / 100;
    row.n = n;
    return row;
  });
  const totalRow = { payment_method: 'Total sales' };
  for (const k of [...secs.map((s) => s.code), 'total']) totalRow[k] = rows.reduce((a, x) => a + Math.round(x[k] * 100), 0) / 100;
  totalRow.n = rows.reduce((a, x) => a + x.n, 0);
  return (
    <ReportTable
      title="Sales by payment method"
      filename="sales_by_payment_method"
      rows={[...rows, totalRow]}
      columns={[
        { key: 'payment_method', label: 'Payment method' },
        ...secs.map((s) => ({ key: s.code, label: s.name, num: true, render: (x) => money(x[s.code]), csv: (x) => x[s.code] })),
        { key: 'total', label: 'Combined', num: true, render: (x) => <b>{money(x.total)}</b>, csv: (x) => x.total },
        { key: 'n', label: 'Sales', num: true },
      ]}
    />
  );
}

function InventoryReport({ section }) {
  const { money, sections } = useSettings();
  const { data: inv, error, reload } = useAsync(() => inventorySummary(section || null), [section]);
  const { data: products } = useAsync(() => productsOverview(section || null), [section]);
  const list = useMemo(() => (products ?? []).filter((p) => p.track_stock), [products]);
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!inv) return <Spinner />;
  return (
    <>
      <div className="kpis">
        <StatCard label="Units in stock" value={int(inv.units_in_stock)} />
        <StatCard estimate label="Stock value at cost" value={money(inv.stock_cost_value)} />
        <StatCard label="Stock value at price" value={money(inv.stock_retail_value)} />
        <StatCard label="Low / out of stock" value={`${inv.low_stock.length} / ${inv.out_of_stock.length}`} tone={inv.out_of_stock.length ? 'bad' : undefined} />
      </div>
      <ReportTable
        title="Low stock & out of stock"
        filename="low_stock"
        rows={[...inv.out_of_stock, ...inv.low_stock]}
        columns={[
          { key: 'name', label: 'Product' },
          { key: 'section_code', label: 'Section', value: (x) => sectionLabel(x.section_code, sections) },
          { key: 'category_name', label: 'Category' },
          { key: 'stock', label: 'Stock', num: true },
          { key: 'min_stock', label: 'Min', num: true },
          { key: 'state', label: 'Status', value: (x) => (x.stock === 0 ? 'Out of stock' : 'Low stock') },
        ]}
      />
      <ReportTable
        title="Inventory (current)"
        filename="inventory"
        rows={list}
        columns={[
          { key: 'name', label: 'Product' },
          { key: 'section_code', label: 'Section', value: (x) => sectionLabel(x.section_code, sections) },
          { key: 'category_name', label: 'Category' },
          { key: 'starting_stock', label: 'Starting', num: true },
          { key: 'sold_qty', label: 'Sold', num: true },
          { key: 'stock', label: 'Current', num: true },
          { key: 'min_stock', label: 'Min', num: true },
          { key: 'cost', label: 'Unit cost', num: true, render: (x) => money(x.cost), csv: (x) => x.cost },
          { key: 'value', label: 'Value at cost', num: true, render: (x) => money((Math.round(x.cost * 100) * x.stock) / 100), csv: (x) => ((Math.round(x.cost * 100) * x.stock) / 100).toFixed(2) },
          { key: 'status', label: 'Status', value: (x) => STOCK_LABEL[stockStatus(x)] },
          { key: 'active', label: 'Active', value: (x) => (x.active ? 'yes' : 'no') },
        ]}
      />
    </>
  );
}

function VoidsReport({ range, section, dateOpts }) {
  const { money, sections } = useSettings();
  const { data, error, reload } = useAsync(
    () => fetchTransactions({ from: range.from, to: range.to, section: section || null, status: 'voided', page: 0, pageSize: 5000 }),
    [range.from, range.to, section],
  );
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  return (
    <ReportTable
      title="Voided sales / refunds"
      filename="voids_refunds"
      rows={data.data}
      columns={[
        { key: 'txn_no', label: 'Transaction' },
        { key: 'created_at', label: 'Sold at', value: (x) => formatDateTime(x.created_at, dateOpts) },
        { key: 'voided_at', label: 'Voided at', value: (x) => formatDateTime(x.voided_at, dateOpts) },
        { key: 'section_code', label: 'Section', value: (x) => sectionLabel(x.section_code, sections) },
        { key: 'cashier', label: 'Cashier', value: (x) => x.cashier?.full_name || x.cashier?.username },
        { key: 'payment_method', label: 'Payment', value: (x) => paymentLabel(x.payment_method) },
        { key: 'total', label: 'Refund', num: true, render: (x) => money(x.total), csv: (x) => x.total },
        { key: 'void_reason', label: 'Reason' },
      ]}
    />
  );
}

function CashReport({ range, section }) {
  const { money, sections, dateOpts } = useSettings();
  const { data, error, reload } = useAsync(() => fetchHandovers({ from: range.from, to: range.to, section: section || null }), [range.from, range.to, section]);
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  const mm = (k, label) => ({ key: k, label, num: true, render: (x) => money(x[k]), csv: (x) => x[k] });
  return (
    <ReportTable
      title="End-of-day cash reconciliation (recorded handovers)"
      filename="cash_reconciliation"
      rows={data}
      columns={[
        { key: 'business_date', label: 'Date' },
        { key: 'section_code', label: 'Section', value: (x) => sectionLabel(x.section_code, sections) },
        { key: 'cashier', label: 'Cashier', value: (x) => x.cashier?.full_name || x.cashier?.username },
        mm('cash_sales', 'Cash sales'),
        mm('cash_refunds', 'Cash refunds'),
        mm('expected_cash', 'Expected cash'),
        mm('actual_cash', 'Actual counted'),
        { ...mm('difference', 'Difference'), render: (x) => <span className={x.difference < 0 ? 'bad-t' : x.difference > 0 ? 'warn-t' : 'ok-t'}>{money(x.difference)}</span> },
        mm('telda_sales', 'Telda'),
        mm('instapay_sales', 'InstaPay'),
        { key: 'notes', label: 'Notes' },
        { key: 'recorded_at', label: 'Recorded', value: (x) => formatDateTime(x.recorded_at, dateOpts) },
      ]}
    />
  );
}
