import { useState } from 'react';
import Modal from '../../components/Modal.jsx';
import ProductImage from '../../components/ProductImage.jsx';
import { useSettings } from '../../context/SettingsContext.jsx';
import { saveProduct, uploadProductImage } from '../../services/admin.js';
import { resizeImage } from '../../utils/image.js';
import { toCents, centsToAmount } from '../../utils/money.js';
import { pct } from '../../utils/format.js';

const blank = (section, lowDefault) => ({
  id: null,
  section_code: section || 'BAZAAR',
  category_id: '',
  name: '',
  sku: '',
  price: '',
  cost: '',
  image_url: '',
  track_stock: true,
  starting_stock: '0',
  min_stock: String(lowDefault ?? 5),
  active: true,
});

export default function ProductForm({ product, defaultSection, categories, onClose, onSaved }) {
  const { settings, sections, money } = useSettings();
  const isNew = !product;
  const [f, setF] = useState(() =>
    product
      ? {
          ...product,
          category_id: product.category_id ?? '',
          sku: product.sku ?? '',
          image_url: product.image_url ?? '',
          price: String(product.price),
          cost: String(product.cost),
          min_stock: String(product.min_stock),
        }
      : blank(defaultSection, settings.low_stock_default),
  );
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));

  const priceC = toCents(f.price);
  const costC = f.cost === '' ? 0 : toCents(f.cost);
  const profitC = priceC - costC;
  const cats = categories.filter((c) => c.section_code === f.section_code);

  const onImage = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const blob = await resizeImage(file);
      const url = await uploadProductImage(blob);
      setF((x) => ({ ...x, image_url: url }));
    } catch (x) {
      setError(x.message);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const submit = async (e) => {
    e?.preventDefault();
    if (Number.isNaN(priceC) || priceC < 0) return setError('Enter a valid selling price.');
    if (Number.isNaN(costC) || costC < 0) return setError('Enter a valid cost (or 0).');
    setBusy(true);
    setError(null);
    try {
      const id = await saveProduct({
        id: f.id,
        section_code: f.section_code,
        category_id: f.category_id === '' ? null : Number(f.category_id),
        name: f.name.trim(),
        sku: f.sku.trim() || null,
        price: centsToAmount(priceC),
        cost: centsToAmount(costC),
        image_url: f.image_url.trim() || null,
        track_stock: f.track_stock,
        starting_stock: isNew && f.track_stock ? Math.max(0, parseInt(f.starting_stock || '0', 10)) : undefined,
        min_stock: f.track_stock ? Math.max(0, parseInt(f.min_stock || '0', 10)) : 0,
        active: f.active,
      });
      onSaved(id);
    } catch (x) {
      setError(x.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isNew ? 'Add product' : `Edit ${product.name}`}
      onClose={onClose}
      closable={!busy}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={submit} disabled={busy || uploading || !f.name.trim()}>
            {busy ? 'Saving…' : 'Save product'}
          </button>
        </>
      }
    >
      <form onSubmit={submit}>
        <div className="frow">
          <label className="f">
            Name
            <input className="input" value={f.name} onChange={set('name')} autoFocus maxLength={120} />
          </label>
          <label className="f">
            Code / SKU (optional)
            <input className="input" value={f.sku} onChange={set('sku')} maxLength={40} />
          </label>
        </div>
        <div className="frow">
          <label className="f">
            Section
            <select
              className="input"
              value={f.section_code}
              onChange={(e) => setF((x) => ({ ...x, section_code: e.target.value, category_id: '' }))}
            >
              {sections.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="f">
            Category
            <select className="input" value={f.category_id} onChange={set('category_id')}>
              <option value="">— none —</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.active ? '' : ' (inactive)'}
                </option>
              ))}
            </select>
            <small>Manage categories under Admin → Categories.</small>
          </label>
        </div>
        <div className="frow">
          <label className="f">
            Selling price ({settings.currency_code})
            <input className="input" inputMode="decimal" value={f.price} onChange={set('price')} placeholder="0.00" />
          </label>
          <label className="f">
            Estimated unit cost ({settings.currency_code})
            <input className="input" inputMode="decimal" value={f.cost} onChange={set('cost')} placeholder="0.00" />
            <small>Admin-only. Never shown to cashiers.</small>
          </label>
        </div>
        {!Number.isNaN(priceC) && !Number.isNaN(costC) && f.price !== '' && (
          <div className="notice info">
            Profit per item: <b>{money(centsToAmount(profitC))}</b> · Margin: <b>{priceC > 0 ? pct((profitC / priceC) * 100) : '—'}</b>
            {!isNew && ' · Changing price/cost affects future sales only; past sales keep their recorded values.'}
          </div>
        )}
        <label className="chk" style={{ marginBottom: 12 }}>
          <input type="checkbox" checked={f.track_stock} onChange={set('track_stock')} disabled={!isNew && product.stock !== 0} /> Track stock
          <span className="muted small">
            {' '}
            (untick for services such as face painting that never run out{!isNew && product.stock !== 0 ? '; set stock to 0 first to change' : ''})
          </span>
        </label>
        {f.track_stock && (
          <div className="frow">
            {isNew ? (
              <label className="f">
                Starting stock
                <input className="input" inputMode="numeric" value={f.starting_stock} onChange={set('starting_stock')} />
              </label>
            ) : (
              <div className="f">
                Current stock
                <div className="big-num">{product.stock}</div>
                <small>Use “Stock ±” on the products list to add/remove stock (a reason is required).</small>
              </div>
            )}
            <label className="f">
              Minimum stock (low-stock warning)
              <input className="input" inputMode="numeric" value={f.min_stock} onChange={set('min_stock')} />
            </label>
          </div>
        )}
        <div className="img-row">
          <ProductImage product={{ name: f.name, image_url: f.image_url }} className="imgprev" />
          <div style={{ flex: 1 }}>
            <label className="f">
              Photo
              <input className="input" type="file" accept="image/*" onChange={onImage} disabled={uploading} />
              <small>{uploading ? 'Uploading…' : 'Resized automatically. Without a photo, a drawing is shown.'}</small>
            </label>
            <label className="f">
              …or image URL
              <input className="input" value={f.image_url} onChange={set('image_url')} placeholder="https://…" />
            </label>
            {f.image_url && (
              <button type="button" className="btn sm" onClick={() => setF((x) => ({ ...x, image_url: '' }))}>
                Remove photo
              </button>
            )}
          </div>
        </div>
        <label className="chk">
          <input type="checkbox" checked={f.active} onChange={set('active')} /> Active (visible and sellable in the POS)
        </label>
        {error && (
          <div className="notice bad" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}
      </form>
    </Modal>
  );
}
