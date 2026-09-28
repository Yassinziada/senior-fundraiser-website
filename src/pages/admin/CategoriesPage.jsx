import { useState } from 'react';
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

  const save = async (c) => {
    try {
      await saveCategory(c);
      toast.ok('Category saved');
      reload({ silent: true });
      return true;
    } catch (e) {
      toast.error(e.message);
      return false;
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
                      <CategoryRow key={c.id} c={c} onSave={save} />
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
                    if (!name) return;
                    if (await save({ section_code: s.code, name, sort_order: list.length + 1 })) setDrafts((d) => ({ ...d, [s.code]: '' }));
                  }}
                >
                  <input
                    className="input"
                    placeholder={`New ${s.name} category`}
                    value={drafts[s.code] ?? ''}
                    onChange={(e) => setDrafts((d) => ({ ...d, [s.code]: e.target.value }))}
                    maxLength={60}
                  />
                  <button type="submit" className="btn primary">
                    Add
                  </button>
                </form>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CategoryRow({ c, onSave }) {
  const [name, setName] = useState(c.name);
  const [order, setOrder] = useState(String(c.sort_order));
  const dirty = name.trim() !== c.name || order !== String(c.sort_order);
  return (
    <tr className={c.active ? '' : 'dim'}>
      <td>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
      </td>
      <td className="num">
        <input className="cell-in" inputMode="numeric" value={order} onChange={(e) => setOrder(e.target.value)} />
      </td>
      <td>{c.active ? <Badge tone="ok">ACTIVE</Badge> : <Badge>INACTIVE</Badge>}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {dirty && (
          <button
            type="button"
            className="btn sm primary"
            onClick={() => onSave({ id: c.id, section_code: c.section_code, name: name.trim(), sort_order: parseInt(order, 10) || 0, active: c.active })}
          >
            Save
          </button>
        )}{' '}
        <button
          type="button"
          className="btn sm"
          onClick={() => onSave({ id: c.id, section_code: c.section_code, name: c.name, sort_order: c.sort_order, active: !c.active })}
        >
          {c.active ? 'Deactivate' : 'Activate'}
        </button>
      </td>
    </tr>
  );
}
