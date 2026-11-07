import { useRef, useState } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { useRealtime } from '../../hooks/useRealtime.js';
import { productsOverview } from '../../services/admin.js';
import { supplierOrders, supplierAccounts, createSupplierOrder, confirmSupplierPurchase, confirmSupplierDelivery, receiveSupplierItem } from '../../services/suppliers.js';
import { ErrorNotice, Spinner } from '../../components/ui.jsx';
import { readJSON } from '../../utils/localStore.js';

export default function SupplierOrdersPage() {
  const { profile } = useAuth();
  const manager = ['admin', 'product_manager'].includes(profile.role);
  const { data, error, loading, reload } = useAsync(supplierOrders, []);
  // Polling also works without adding supplier tables to the realtime publication.
  useRealtime([], () => reload({ silent: true }));
  const { data: options } = useAsync(async () => manager ? {
    suppliers: await supplierAccounts(), products: await productsOverview(null),
  } : null, [manager]);
  const [title, setTitle] = useState('');
  const [supplier, setSupplier] = useState('');
  const [lines, setLines] = useState([{ product_id: '', quantity: '1' }]);
  const storageKey = `pos.supplierAction.${profile.id}`;
  const [pending, setPending] = useState(() => readJSON(storageKey));
  const pendingRef = useRef(pending);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const send = async (action) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      // Refuse to send if the retry key cannot survive a refresh.
      localStorage.setItem(storageKey, JSON.stringify(action));
      pendingRef.current = action;
      setPending(action);
      if (action.type === 'create') await createSupplierOrder(action);
      else if (action.type === 'purchase') await confirmSupplierPurchase(action);
      else if (action.type === 'delivery') await confirmSupplierDelivery(action);
      else await receiveSupplierItem(action);
      localStorage.removeItem(storageKey);
      pendingRef.current = null;
      setPending(null);
      if (action.type === 'create') { setTitle(''); setLines([{ product_id: '', quantity: '1' }]); }
      await reload({ silent: true });
      return true;
    } catch (e) {
      if (!e.network && typeof e.code === 'string') {
        localStorage.removeItem(storageKey);
        pendingRef.current = null;
        setPending(null);
      }
      setMessage(e.message);
    } finally { busyRef.current = false; setBusy(false); }
  };
  const create = (e) => {
    e.preventDefault();
    if (pendingRef.current || busyRef.current) return;
    if (new Set(lines.map((l) => l.product_id)).size !== lines.length) return setMessage('Choose each product once.');
    send({ type: 'create', key: crypto.randomUUID(), supplier, title: title.trim(),
      items: lines.map((l) => ({ product_id: Number(l.product_id), quantity: Number(l.quantity) })) });
  };
  const confirm = (type, item, quantity) => {
    if (pendingRef.current || busyRef.current) return;
    return send({ type, key: crypto.randomUUID(), item: item.id, quantity });
  };
  const products = (options?.products ?? []).filter((p) => p.active && p.track_stock);
  return <div className="page">
    <div className="page-head"><div><h1>Supplier lists</h1>
      <p>{manager ? 'Assign a list to a supplier. Stock can be received only after the supplier confirms purchase and delivery.' : 'Confirm the total quantity you bought, then the total quantity you delivered. Only your assigned lists appear here.'}</p>
      <p className="muted">Purchase and delivery confirmations do not add stock. The receiver confirms what physically arrived.</p></div>
      <button className="btn" onClick={() => reload()}>Refresh</button>
    </div>
    <ErrorNotice error={error} onRetry={reload} />
    {message && <div className="notice bad" role="alert">{message}</div>}
    {pending && <div className="notice warn" role="alert">
      An earlier action is unconfirmed. Retry the same action before starting another.
      <button className="btn" disabled={busy} onClick={() => send(pending)}>Retry safely</button>
    </div>}
    {manager && <form className="card" onSubmit={create}>
      <h2>New supplier list</h2>
      <fieldset disabled={busy || !!pending} style={{ border: 0, padding: 0 }}>
        <div className="frow">
          <label className="f">List title<input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} /></label>
          <label className="f">Supplier<select aria-label="Supplier" className="input" value={supplier} onChange={(e) => setSupplier(e.target.value)} required>
            <option value="">Choose supplier</option>
            {(options?.suppliers ?? []).map((s) => <option key={s.id} value={s.id}>{s.full_name || s.username}</option>)}
          </select></label>
        </div>
        {lines.map((line, i) => <div className="frow" key={i}>
          <label className="f">Product<select aria-label="Product" className="input" required value={line.product_id} onChange={(e) => setLines(lines.map((l, j) => j === i ? { ...l, product_id: e.target.value } : l))}>
            <option value="">Choose product</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.section_code})</option>)}
          </select></label>
          <label className="f">Quantity<input className="input" type="number" min="1" max="100000" step="1" required value={line.quantity} onChange={(e) => setLines(lines.map((l, j) => j === i ? { ...l, quantity: e.target.value } : l))} /></label>
          {lines.length > 1 && <button type="button" className="btn" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button>}
        </div>)}
        <div className="actions">
          <button type="button" className="btn" disabled={lines.length >= 200} onClick={() => setLines([...lines, { product_id: '', quantity: '1' }])}>Add product</button>
          <button className="btn primary" type="submit">Send list</button>
        </div>
        {!options?.suppliers?.length && <p className="muted">An admin must create an active Supplier account before a list can be assigned.</p>}
      </fieldset>
    </form>}
    {loading && !data ? <Spinner /> : (data ?? []).length === 0 ? <div className="empty">No supplier lists yet.</div> :
      data.map((order) => <div className="card" key={order.id} style={{ marginTop: 16 }}>
        <h2>{order.title}</h2>
        {manager && <p className="muted">Supplier: {options?.suppliers?.find((s) => s.id === order.supplier_id)?.full_name || options?.suppliers?.find((s) => s.id === order.supplier_id)?.username || 'Inactive supplier'}</p>}
        <div className="table-wrap"><table className="tbl">
          <thead><tr><th>Product</th><th>Requested</th><th>Purchased</th><th>Delivered</th><th>Received</th>{manager && <th>Confirm receipt</th>}</tr></thead>
          <tbody>{[...order.items].sort((a, b) => a.id - b.id).map((item) => <tr key={item.id}>
            <td>{item.product_name}</td><td>{item.quantity}</td>
            <td>{manager ? <ProgressQuantity value={item.purchased} confirmed={item.purchased_at} /> :
              <SupplierQuantityForm item={item} stage="purchase" disabled={busy || !!pending} onConfirm={(quantity) => confirm('purchase', item, quantity)} />}</td>
            <td>{manager ? <ProgressQuantity value={item.delivered} confirmed={item.delivered_at} /> :
              <SupplierQuantityForm item={item} stage="delivery" disabled={busy || !!pending} onConfirm={(quantity) => confirm('delivery', item, quantity)} />}</td>
            <td>{item.received} / {item.quantity}</td>
            {manager && <td><ReceiveForm item={item} disabled={busy || !!pending} onReceive={(quantity) => {
              return confirm('receive', item, quantity);
            }} /></td>}
          </tr>)}</tbody>
        </table></div>
      </div>)}
  </div>;
}

function ReceiveForm({ item, disabled, onReceive }) {
  const [quantity, setQuantity] = useState('');
  if (item.received === item.quantity) return 'Complete';
  const remaining = item.delivered - item.received;
  const ready = !!item.purchased_at && !!item.delivered_at && remaining > 0;
  const valid = Number.isInteger(Number(quantity)) && Number(quantity) > 0 && Number(quantity) <= remaining;
  return <form className="actions" onSubmit={async (e) => { e.preventDefault(); if (!disabled && ready && valid && await onReceive(Number(quantity))) setQuantity(''); }}>
    <span className="muted small">{ready ? `${remaining} delivered units awaiting receipt` : !item.purchased_at ? 'Awaiting supplier purchase confirmation' : !item.delivered_at ? 'Awaiting supplier delivery confirmation' : 'All confirmed deliveries received'}</span>
    <input className="input" style={{ width: 100 }} aria-label={`Received quantity for ${item.product_name}`} type="number" required min="1" max={remaining || undefined} step="1" value={quantity} disabled={disabled || !ready} onChange={(e) => setQuantity(e.target.value)} />
    <button className="btn sm primary" disabled={disabled || !ready || !valid} type="submit">Confirm received</button>
  </form>;
}

function ProgressQuantity({ value, confirmed }) {
  return <span>{value}<small className="muted" style={{ display: 'block' }}>{confirmed ? 'Supplier confirmed' : value > 0 ? 'Previously received' : 'Not confirmed'}</small></span>;
}

function SupplierQuantityForm({ item, stage, disabled, onConfirm }) {
  const [quantity, setQuantity] = useState('');
  const purchase = stage === 'purchase';
  const current = purchase ? item.purchased : item.delivered;
  const confirmed = purchase ? item.purchased_at : item.delivered_at;
  const maximum = purchase ? item.quantity : item.purchased;
  const allowed = purchase || !!item.purchased_at;
  const valid = Number.isInteger(Number(quantity)) && Number(quantity) >= Math.max(1, current) && Number(quantity) <= maximum;
  return <div>
    <ProgressQuantity value={current} confirmed={confirmed} />
    {confirmed && current === maximum ? <small className="muted">{purchase ? 'Requested quantity bought' : 'Purchased quantity delivered'}</small> :
      <form onSubmit={async (e) => { e.preventDefault(); if (!disabled && allowed && valid && await onConfirm(Number(quantity))) setQuantity(''); }}>
        <label className="f">{purchase ? 'Total bought' : 'Total delivered'}
          <input className="input" style={{ width: 100 }} aria-label={`Total ${purchase ? 'bought' : 'delivered'} for ${item.product_name}`} type="number" required min={Math.max(1, current)} max={maximum || undefined} step="1" value={quantity} disabled={disabled || !allowed} onChange={(e) => setQuantity(e.target.value)} />
        </label>
        <small className="muted">{allowed ? `Total so far, including earlier batches (up to ${maximum})` : 'Confirm purchase first'}</small>
        <button className="btn sm primary" type="submit" disabled={disabled || !allowed || !valid}>Confirm {purchase ? 'purchased' : 'delivered'}</button>
      </form>}
  </div>;
}
