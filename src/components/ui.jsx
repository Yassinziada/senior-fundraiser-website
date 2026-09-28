// Small shared UI pieces.
export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorNotice({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="notice bad" role="alert">
      <b>{error.network ? 'Connection problem. ' : ''}</b>
      {error.message || String(error)}
      {onRetry && (
        <button type="button" className="btn sm" style={{ marginLeft: 10 }} onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

export function Badge({ tone = 'muted', children }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function TxnStatusBadge({ status, voidRequest }) {
  if (status === 'voided') return <Badge tone="bad">VOIDED</Badge>;
  if (voidRequest?.status === 'pending') return <Badge tone="warn">VOID REQUESTED</Badge>;
  if (voidRequest?.status === 'rejected') return <Badge tone="muted">VOID REJECTED</Badge>;
  return <Badge tone="ok">COMPLETED</Badge>;
}

export function StatCard({ label, value, sub, tone, estimate = false }) {
  return (
    <div className={`kpi ${estimate ? 'est' : ''} ${tone ? `kpi-${tone}` : ''}`}>
      <div className="k">
        {label}
        {estimate && <span className="est-tag">EST.</span>}
      </div>
      <div className="v">{value}</div>
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}

/** Horizontal single-series bar list. Values are always printed as text, so
 *  nothing relies on colour alone; hover shows the exact value. */
export function BarList({ rows, format = (v) => v, empty = 'No data yet.', max: maxProp }) {
  if (!rows?.length) return <Empty>{empty}</Empty>;
  const max = maxProp ?? Math.max(...rows.map((r) => Number(r.value) || 0), 0);
  return (
    <div className="bars" role="list">
      {rows.map((r) => (
        <div className="bar-row" role="listitem" key={r.key ?? r.label} title={`${r.label}: ${format(r.value)}`}>
          <span className="bn">{r.label}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${max > 0 ? Math.max(1, (Number(r.value) / max) * 100) : 0}%` }} />
          </span>
          <span className="bv">{format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

/** Vertical column chart for sales by hour (single series). */
export function ColumnChart({ rows, format = (v) => v }) {
  if (!rows?.length) return <Empty>No sales in this period.</Empty>;
  const max = Math.max(...rows.map((r) => Number(r.value) || 0), 0);
  return (
    <div className="cols" role="list">
      {rows.map((r) => (
        <div className="col" role="listitem" key={r.key ?? r.label} title={`${r.label}: ${format(r.value)}`}>
          <span className="col-bar" style={{ height: `${max > 0 ? Math.max(2, (Number(r.value) / max) * 100) : 0}%` }} />
          <span className="col-l">{r.label}</span>
        </div>
      ))}
    </div>
  );
}
