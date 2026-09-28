import { useMemo, useState } from 'react';
import { useSettings } from '../../context/SettingsContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { useRealtime } from '../../hooks/useRealtime.js';
import { fetchCategories, productsOverview, setProductActive } from '../../services/admin.js';
import { SectionFilter } from '../../components/Filters.jsx';
import { ErrorNotice, Spinner, Badge } from '../../components/ui.jsx';
import ProductImage from '../../components/ProductImage.jsx';
import { stockStatus, STOCK_LABEL, STOCK_TONE } from '../../utils/stock.js';
import { pct, sectionLabel } from '../../utils/format.js';
import { exportCSV } from '../../utils/csv.js';
import ProductForm from './ProductForm.jsx';
import StockAdjustModal from './StockAdjustModal.jsx';

export default function ProductsPage() {
  const { money, sections } = useSettings();
  const toast = useToast();
  const [section, setSection] = useState('');
  const [catId, setCatId] = useState('');
  const [statusF, setStatusF] = useState('active'); // all|active|inactive
  const [stockF, setStockF] = useState(''); // ''|low|out
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null); // product | 'new'
  const [adjusting, setAdjusting] = useState(null);

  const { data, error, loading, reload } = useAsync(() => productsOverview(null), []);
  const { data: categories, reload: reloadCats } = useAsync(() => fetchCategories(null), []);
  useRealtime(['products'], () => reload({ silent: true }));

  const catName = useMemo(() => new Map((categories ?? []).map((c) => [c.id, c.name])), [categories]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data ?? []).filter((p) => {
      if (section && p.section_code !== section) return false;
      if (catId && String(p.category_id) !== catId) return false;
      if (statusF === 'active' && !p.active) return false;
      if (statusF === 'inactive' && p.active) return false;
      const st = stockStatus(p);
      if (stockF === 'low' && st !== 'low') return false;
      if (stockF === 'out' && st !== 'out') return false;
      if (needle && !p.name.toLowerCase().includes(needle) && !(p.sku ?? '').toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [data, section, catId, statusF, stockF, q]);

  const toggle = async (p) => {
    try {
      await setProductActive(p.id, !p.active);
      toast.ok(`${p.name} ${p.active ? 'deactivated' : 'activated'}`);
      reload({ silent: true });
    } catch (e) {
      toast.error(e.message);
    }
  };

  const doExport = () =>
    exportCSV('products', rows, [
      { key: 'id', label: 'ID' },
      { key: 'sku', label: 'SKU' },
      { key: 'section_code', label: 'Section' },
      { key: 'category_name', label: 'Category' },
      { key: 'name', label: 'Name' },
      { key: 'price', label: 'Price' },
      { key: 'cost', label: 'Cost' },
      { key: 'profit_per_item', label: 'Profit/item' },
      { key: 'margin_pct', label: 'Margin %' },
      { key: 'starting_stock', label: 'Starting stock' },
      { key: 'sold_qty', label: 'Sold' },
      { key: 'stock', label: 'Current stock' },
      { key: 'min_stock', label: 'Min stock' },
      { key: 'status', label: 'Stock status', value: (p) => STOCK_LABEL[stockStatus(p)] },
      { key: 'active', label: 'Active', value: (p) => (p.active ? 'yes' : 'no') },
    ]);

  const catsForFilter = (categories ?? []).filter((c) => !section || c.section_code === section);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Products</h1>
          <p>{rows.length} shown. Cost, profit and margin are visible to admins only.</p>
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={doExport}>
            Export CSV
          </button>
          <button type="button" className="btn primary" onClick={() => setEditing('new')}>
            + Add product
          </button>
        </div>
      </div>
      <div className="toolbar">
        <SectionFilter
          value={section}
          onChange={(v) => {
            setSection(v);
            setCatId('');
          }}
        />
        <select className="input" value={catId} onChange={(e) => setCatId(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {catsForFilter.map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.name}
              {!section ? ` (${sectionLabel(c.section_code, sections)})` : ''}
            </option>
          ))}
        </select>
        <select className="input" value={statusF} onChange={(e) => setStatusF(e.target.value)} aria-label="Status">
          <option value="all">Active & inactive</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        <select className="input" value={stockF} onChange={(e) => setStockF(e.target.value)} aria-label="Stock">
          <option value="">Any stock</option>
          <option value="low">Low stock</option>
          <option value="out">Out of stock</option>
        </select>
        <input className="input" placeholder="Search name / SKU…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ErrorNotice error={error} onRetry={reload} />
      {loading && !data ? (
        <Spinner />
      ) : (
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th />
                <th>Product</th>
                <th>Section</th>
                <th className="num">Price</th>
                <th className="num">Cost</th>
                <th className="num">Profit/item</th>
                <th className="num">Margin</th>
                <th className="num">Start</th>
                <th className="num">Sold</th>
                <th className="num">Stock</th>
                <th className="num">Min</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={13} className="muted" style={{ textAlign: 'center', padding: 30 }}>
                    No products match. Add one, or import your old catalogue (Admin → Import).
                  </td>
                </tr>
              )}
              {rows.map((p) => {
                const st = stockStatus(p);
                return (
                  <tr key={p.id} className={p.active ? '' : 'dim'}>
                    <td>
                      <ProductImage product={p} className="thumb-s" />
                    </td>
                    <td>
                      <b>{p.name}</b>
                      <div className="muted small">
                        #{p.id}
                        {p.sku ? ` · ${p.sku}` : ''} · {p.category_name ?? catName.get(p.category_id) ?? 'No category'}
                      </div>
                    </td>
                    <td>{sectionLabel(p.section_code, sections)}</td>
                    <td className="num">{money(p.price)}</td>
                    <td className="num">{money(p.cost)}</td>
                    <td className={`num ${p.profit_per_item < 0 ? 'bad-t' : ''}`}>{money(p.profit_per_item)}</td>
                    <td className="num">{pct(p.margin_pct)}</td>
                    <td className="num">{p.track_stock ? p.starting_stock : '—'}</td>
                    <td className="num">{p.sold_qty}</td>
                    <td className="num">
                      <b>{p.track_stock ? p.stock : '∞'}</b>
                    </td>
                    <td className="num">{p.track_stock ? p.min_stock : '—'}</td>
                    <td>
                      <Badge tone={STOCK_TONE[st]}>{STOCK_LABEL[st].toUpperCase()}</Badge>
                      {!p.active && (
                        <div>
                          <Badge>INACTIVE</Badge>
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button type="button" className="btn sm" onClick={() => setEditing(p)}>
                          Edit
                        </button>
                        {p.track_stock && (
                          <button type="button" className="btn sm" onClick={() => setAdjusting(p)}>
                            Stock ±
                          </button>
                        )}
                        <button type="button" className="btn sm" onClick={() => toggle(p)}>
                          {p.active ? 'Deactivate' : 'Activate'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <ProductForm
          product={editing === 'new' ? null : editing}
          defaultSection={section}
          categories={categories ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            toast.ok('Product saved');
            setEditing(null);
            reload({ silent: true });
            reloadCats({ silent: true });
          }}
        />
      )}
      {adjusting && (
        <StockAdjustModal
          product={adjusting}
          onClose={() => setAdjusting(null)}
          onSaved={() => {
            toast.ok('Stock updated');
            setAdjusting(null);
            reload({ silent: true });
          }}
        />
      )}
    </div>
  );
}
