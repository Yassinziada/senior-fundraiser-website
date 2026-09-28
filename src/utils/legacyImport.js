// Importer for product data coming from the ORIGINAL single-file Bazaar POS
// (its "Download backup" JSON file) or from a CSV spreadsheet.
// Only PRODUCTS and CATEGORIES are imported. Transactions, users and the old
// audit log are deliberately ignored so test sales never reach production.
//
// Original backup format (legacy/Bazaar-POS-original.html, makeBackup()):
//   { app: "bazaar-pos", schema: 1, exportedAt, data: {
//       categories: [{ id: "C1", name: "Accessories" }],
//       products: [{ id: "P001", name, categoryId, cost, price, startStock, stock,
//                    minStock, active, image, service }] } }
//   Money in that file is in PIASTERS (integer, 2500 = 25.00 EGP).

const LEGACY_APP_ID = 'bazaar-pos';

/** Parse CSV text into an array of objects keyed by (lower-cased) header. */
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text ?? '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!nonEmpty.length) return [];
  const headers = nonEmpty[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  return nonEmpty.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const pick = (obj, keys) => {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  return undefined;
};

const toNum = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/,/g, '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const toBool = (v, dflt) => {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  return /^(1|true|yes|y|active|on)$/i.test(String(v).trim());
};

function normaliseSection(v, fallback) {
  const s = String(v ?? '').trim().toUpperCase();
  if (s.startsWith('SNACK')) return 'SNACKS';
  if (s.startsWith('BAZAAR')) return 'BAZAAR';
  return fallback;
}

/**
 * Turn any supported input into rows for admin_import_products:
 *   { section_code, category, name, sku, price, cost, stock, min_stock,
 *     track_stock, active, image_data_url?, image_url? }
 * Returns { rows, warnings, source }.
 */
export function parseProductsFile(text, { defaultSection = 'BAZAAR', fileName = '' } = {}) {
  const warnings = [];
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { rows: [], warnings: ['The file is empty.'], source: 'empty' };

  // ---- JSON (old POS backup, or a plain array of products) ----
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let json;
    try {
      json = JSON.parse(trimmed);
    } catch {
      return { rows: [], warnings: ['This file is not valid JSON.'], source: 'json' };
    }
    const data = json?.data && typeof json.data === 'object' ? json.data : json;
    const isLegacy = json?.app === LEGACY_APP_ID;
    const products = Array.isArray(data) ? data : Array.isArray(data?.products) ? data.products : null;
    if (!products) return { rows: [], warnings: ['No "products" list found in this file.'], source: 'json' };
    const cats = new Map((Array.isArray(data?.categories) ? data.categories : []).map((c) => [c.id, c.name]));
    // the old POS stored money in piasters (integers)
    const moneyDivisor = isLegacy ? 100 : 1;
    if (isLegacy && Array.isArray(data?.txns) && data.txns.length) {
      warnings.push(`${data.txns.length} old transaction(s) in the backup were NOT imported (products only).`);
    }
    const rows = [];
    for (const p of products) {
      const name = String(pick(p, ['name', 'title', 'productName']) ?? '').trim();
      if (!name) {
        warnings.push('Skipped a product without a name.');
        continue;
      }
      const service = toBool(p.service, false);
      const rawPrice = toNum(pick(p, ['price', 'sellingPrice', 'salePrice']));
      const rawCost = toNum(pick(p, ['cost', 'unitCost', 'costPrice', 'estimatedCost']));
      if (rawPrice === null) warnings.push(`${name}: had no selling price — imported as 0, set it before selling.`);
      const image = pick(p, ['image', 'imageUrl', 'image_url', 'photo']);
      rows.push({
        section_code: normaliseSection(p.section, defaultSection),
        category: cats.get(p.categoryId) ?? pick(p, ['category', 'categoryName']) ?? null,
        name,
        sku: p.id ? String(p.id) : null,
        price: rawPrice === null ? 0 : rawPrice / moneyDivisor,
        cost: rawCost === null ? 0 : rawCost / moneyDivisor,
        stock: service ? 0 : Math.max(0, Math.floor(toNum(pick(p, ['stock', 'currentStock', 'qty', 'quantity'])) ?? 0)),
        min_stock: service ? 0 : Math.max(0, Math.floor(toNum(pick(p, ['minStock', 'min_stock', 'minimumStock'])) ?? 0)),
        track_stock: !service,
        active: toBool(p.active, true),
        ...(typeof image === 'string' && image.startsWith('data:image/')
          ? { image_data_url: image }
          : typeof image === 'string' && /^https?:\/\//.test(image)
            ? { image_url: image }
            : {}),
      });
    }
    return { rows, warnings, source: isLegacy ? 'legacy-backup' : 'json' };
  }

  // ---- CSV ----
  const records = parseCSV(trimmed);
  const rows = [];
  for (const r of records) {
    const name = String(pick(r, ['name', 'product', 'product_name']) ?? '').trim();
    if (!name) continue;
    const trackRaw = pick(r, ['track_stock', 'service']);
    const service = r.service !== undefined ? toBool(r.service, false) : !toBool(trackRaw, true);
    rows.push({
      section_code: normaliseSection(pick(r, ['section', 'section_code']), defaultSection),
      category: pick(r, ['category', 'category_name']) ?? null,
      name,
      sku: pick(r, ['sku', 'code', 'id']) ?? null,
      price: toNum(pick(r, ['price', 'selling_price', 'sale_price'])) ?? 0,
      cost: toNum(pick(r, ['cost', 'unit_cost', 'estimated_cost'])) ?? 0,
      stock: service ? 0 : Math.max(0, Math.floor(toNum(pick(r, ['stock', 'starting_stock', 'quantity', 'qty'])) ?? 0)),
      min_stock: service ? 0 : Math.max(0, Math.floor(toNum(pick(r, ['min_stock', 'minimum_stock'])) ?? 0)),
      track_stock: !service,
      active: toBool(r.active, true),
      ...(r.image_url && /^https?:\/\//.test(r.image_url) ? { image_url: r.image_url } : {}),
    });
  }
  if (!rows.length) warnings.push(`No products found in ${fileName || 'the file'}. The first row must be a header with at least "name" and "price".`);
  return { rows, warnings, source: 'csv' };
}

export const CSV_TEMPLATE =
  'section,category,name,sku,price,cost,stock,min_stock,track_stock,active,image_url\r\n' +
  'BAZAAR,Accessories,Keychains,BZ-001,40,20,20,5,yes,yes,\r\n' +
  'SNACKS,Drinks,Water bottle,SN-001,10,5,48,6,yes,yes,\r\n' +
  'BAZAAR,Services,Face painting,BZ-100,30,5,0,0,no,yes,\r\n';
