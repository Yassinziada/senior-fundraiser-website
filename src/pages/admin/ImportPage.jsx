import { useState } from 'react';
import { useSettings } from '../../context/SettingsContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { importProducts, uploadProductImage } from '../../services/admin.js';
import { SectionFilter } from '../../components/Filters.jsx';
import { parseProductsFile, CSV_TEMPLATE } from '../../utils/legacyImport.js';
import { downloadFile } from '../../utils/csv.js';
import { resizeImage } from '../../utils/image.js';

/**
 * Bring products over from the ORIGINAL single-file POS (its backup .json) or
 * from a spreadsheet (.csv). Only products & categories are imported — never
 * old/test transactions. Products whose name already exists are skipped.
 */
export default function ImportPage() {
  const { money, sections } = useSettings();
  const toast = useToast();
  const [defaultSection, setDefaultSection] = useState('BAZAAR');
  const [parsed, setParsed] = useState(null);
  const [fileText, setFileText] = useState(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState(null);

  const parse = (text, name, section) => setParsed(parseProductsFile(text, { defaultSection: section, fileName: name }));

  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setResult(null);
    const reader = new FileReader();
    reader.onload = () => {
      setFileText(reader.result);
      setFileName(f.name);
      parse(reader.result, f.name, defaultSection);
    };
    reader.readAsText(f);
  };

  const run = async () => {
    if (!parsed?.rows.length) return;
    setBusy(true);
    setResult(null);
    try {
      // upload embedded photos (the old POS stored them inside the backup)
      const rows = [];
      let i = 0;
      for (const r of parsed.rows) {
        i += 1;
        const { image_data_url: dataUrl, ...row } = r;
        if (dataUrl) {
          setProgress(`Uploading photo ${i} of ${parsed.rows.length}…`);
          try {
            row.image_url = await uploadProductImage(await resizeImage(dataUrl));
          } catch {
            /* keep going without the photo */
          }
        }
        rows.push(row);
      }
      setProgress('Saving products…');
      const res = await importProducts(rows);
      setResult(res);
      toast.ok(`${res.created} product(s) imported`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Import products</h1>
          <p>From the original Bazaar POS backup file (.json) or a spreadsheet (.csv). Transactions are never imported.</p>
        </div>
        <button type="button" className="btn" onClick={() => downloadFile('products_template.csv', '﻿' + CSV_TEMPLATE)}>
          Download CSV template
        </button>
      </div>
      <div className="card">
        <h3>1. Where do products without a section go?</h3>
        <SectionFilter
          value={defaultSection}
          allowAll={false}
          onChange={(v) => {
            setDefaultSection(v);
            if (fileText) parse(fileText, fileName, v);
          }}
        />
        <p className="muted small">The old POS only had the Bazaar, so its products go to the section chosen here. A CSV “section” column overrides it.</p>
        <h3 style={{ marginTop: 16 }}>2. Choose the file</h3>
        <input className="input" type="file" accept=".json,.csv,application/json,text/csv" onChange={onFile} disabled={busy} />
        <p className="muted small">
          Old POS: open it, sign in as coordinator, Settings → <b>Download backup</b>. Choose that .json file here. Prices, costs, stock, minimum stock,
          categories, services and photos are brought over.
        </p>
      </div>

      {parsed && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>
            3. Check and import — {parsed.rows.length} product{parsed.rows.length === 1 ? '' : 's'} found
            {parsed.source === 'legacy-backup' && ' (original POS backup)'}
          </h3>
          {parsed.warnings.map((w) => (
            <div key={w} className="notice warn">
              {w}
            </div>
          ))}
          {parsed.rows.length > 0 && (
            <div className="table-wrap flat" style={{ maxHeight: 420 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Section</th>
                    <th>Category</th>
                    <th>Name</th>
                    <th className="num">Price</th>
                    <th className="num">Cost</th>
                    <th className="num">Stock</th>
                    <th className="num">Min</th>
                    <th>Photo</th>
                    <th>Active</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.map((r, i) => (
                    <tr key={i}>
                      <td>{sections.find((s) => s.code === r.section_code)?.name ?? r.section_code}</td>
                      <td>{r.category ?? '—'}</td>
                      <td>{r.name}</td>
                      <td className="num">{money(r.price)}</td>
                      <td className="num">{money(r.cost)}</td>
                      <td className="num">{r.track_stock ? r.stock : 'service'}</td>
                      <td className="num">{r.track_stock ? r.min_stock : '—'}</td>
                      <td>{r.image_data_url || r.image_url ? '✓' : ''}</td>
                      <td>{r.active ? 'yes' : 'no'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="actions" style={{ marginTop: 12 }}>
            <button type="button" className="btn primary" onClick={run} disabled={busy || !parsed.rows.length}>
              {busy ? progress || 'Importing…' : `Import ${parsed.rows.length} product(s)`}
            </button>
          </div>
          {result && (
            <div className="notice ok" style={{ marginTop: 12 }}>
              Imported <b>{result.created}</b> product(s), created <b>{result.categories_created}</b> categor
              {result.categories_created === 1 ? 'y' : 'ies'}.
              {result.skipped?.length > 0 && <> Skipped (already exist): {result.skipped.join(', ')}.</>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
