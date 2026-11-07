import { useRef, useState } from 'react';
import { useSettings } from '../../context/SettingsContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { fetchCategories, saveCategory } from '../../services/admin.js';
import { ErrorNotice, Spinner, Badge } from '../../components/ui.jsx';

export default function CategoriesPage() {
  const { sections } = useSettings();
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(() => fetchCategories(null), []);
  const [drafts, setDrafts] = useState({}); // section -> name
  const [formErrors, setFormErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const save = async (c) => {
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setFormErrors((current) => ({ ...current, [c.section_code]: '' }));
    try {
      await saveCategory(c);
      toast.ok('Category saved');
      await reload({ silent: true });
      return true;
    } catch (e) {
      setFormErrors((current) => ({ ...current, [c.section_code]: e.message }));
      toast.error(e.message);
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Categories</h1>
          <p>Each section has its own categories. Inactive categories are hidden from cashiers (their products stay sellable under “All”).</p>
        </div>
      </div>
      <ErrorNotice error={error} onRetry={reload} />
      {loading && !data ? (
        <Spinner />
      ) : (
        <div className="grid2">
          {sections.map((s) => {
            const list = (data ?? []).filter((c) => c.section_code === s.code);
            return (
              <div className="card" key={s.code}>
                <h2>{s.name}</h2>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th className="num">Order</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((c) => (
                      <CategoryRow key={c.id} c={c} onSave={save} disabled={saving} />
                    ))}
                    {list.length === 0 && (
                      <tr>
                        <td colSpan={4} className="muted">
                          No categories yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
                <form
                  className="toolbar"
                  style={{ marginTop: 12 }}
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const name = (drafts[s.code] ?? '').trim();
                    if (!name) {
                      setFormErrors((current) => ({ ...current, [s.code]: 'Enter a category name, then press Add.' }));
                      return;
                    }
                    if (await save({ section_code: s.code, name, sort_order: list.length + 1 })) setDrafts((d) => ({ ...d, [s.code]: '' }));
                  }}
                >
                  <input
                    className="input"
                    placeholder={`New ${s.name} category`}
                    aria-label={`New ${s.name} category`}
                    aria-describedby={formErrors[s.code] ? `category-error-${s.code}` : undefined}
                    aria-invalid={!!formErrors[s.code]}
                    disabled={saving}
                    value={drafts[s.code] ?? ''}
                    onChange={(e) => {
                      setDrafts((d) => ({ ...d, [s.code]: e.target.value }));
                      setFormErrors((current) => ({ ...current, [s.code]: '' }));
                    }}
                    maxLength={60}
                  />
                  <button type="submit" className="btn primary" disabled={saving}>
                    {saving ? 'Saving…' : 'Add'}
                  </button>
                </form>
                {formErrors[s.code] && <p id={`category-error-${s.code}`} className="notice bad" role="alert">{formErrors[s.code]}</p>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CategoryRow({ c, onSave, disabled }) {
  const [name, setName] = useState(c.name);
  const [order, setOrder] = useState(String(c.sort_order));
  const dirty = name.trim() !== c.name || order !== String(c.sort_order);
  return (
    <tr className={c.active ? '' : 'dim'}>
      <td>
        <input className="input" aria-label={`Category name ${c.name}`} disabled={disabled} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
      </td>
      <td className="num">
        <input className="cell-in" aria-label={`Sort order for ${c.name}`} disabled={disabled} inputMode="numeric" value={order} onChange={(e) => setOrder(e.target.value)} />
      </td>
      <td>{c.active ? <Badge tone="ok">ACTIVE</Badge> : <Badge>INACTIVE</Badge>}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {dirty && (
          <button
            type="button"
            className="btn sm primary"
            disabled={disabled}
            onClick={() => onSave({ id: c.id, section_code: c.section_code, name: name.trim(), sort_order: parseInt(order, 10) || 0, active: c.active })}
          >
            Save
          </button>
        )}{' '}
        <button
          type="button"
          className="btn sm"
          disabled={disabled}
          onClick={() => onSave({ id: c.id, section_code: c.section_code, name: c.name, sort_order: c.sort_order, active: !c.active })}
        >
          {c.active ? 'Deactivate' : 'Activate'}
        </button>
      </td>
    </tr>
  );
}
