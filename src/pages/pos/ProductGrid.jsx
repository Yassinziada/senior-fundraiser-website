import ProductImage from '../../components/ProductImage.jsx';
import { useSettings } from '../../context/SettingsContext.jsx';
import { stockStatus } from '../../utils/stock.js';

export default function ProductGrid({ products, cartQty, onAdd, disabled }) {
  const { money } = useSettings();
  if (!products.length) return <div className="empty" style={{ gridColumn: '1/-1' }}>No products match.</div>;
  return products.map((p) => {
    const inCart = cartQty(p.id);
    const status = stockStatus(p);
    const left = p.track_stock ? p.stock - inCart : Infinity;
    let cls = '';
    let badge = null;
    if (status === 'out') {
      cls = 'is-out';
      badge = <span className="badge bad">OUT OF STOCK</span>;
    } else if (left <= 0) {
      cls = 'is-off';
      badge = <span className="badge muted">ALL IN CART</span>;
    } else if (status === 'low') {
      badge = <span className="badge warn">LOW STOCK</span>;
    }
    return (
      <button
        type="button"
        key={p.id}
        className={`pcard ${cls} ${inCart ? 'sel' : ''}`}
        onClick={() => onAdd(p)}
        disabled={disabled}
        aria-disabled={!!cls}
        aria-label={`${p.name}, ${money(p.price)}${inCart ? `, ${inCart} in cart` : ''}`}
      >
        {badge}
        {inCart > 0 && <span className="incart">{inCart}</span>}
        <span className="pname">{p.name}</span>
        <ProductImage product={p} />
        <span className="pprice">{money(p.price)}</span>
        <span className="pstock">{p.track_stock ? `${p.stock} left` : 'Service'}</span>
      </button>
    );
  });
}
