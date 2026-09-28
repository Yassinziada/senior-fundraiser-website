import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseProductsFile, parseCSV, CSV_TEMPLATE } from '../../src/utils/legacyImport.js';

describe('import from the original POS', () => {
  it('reads an original backup file (piasters -> EGP, categories, services, images) and ignores transactions', () => {
    const backup = {
      app: 'bazaar-pos',
      schema: 1,
      exportedAt: '2026-09-01T10:00:00Z',
      data: {
        categories: [{ id: 'C1', name: 'Accessories' }, { id: 'C5', name: 'Services' }],
        products: [
          { id: 'P001', name: 'Phone charms', categoryId: 'C1', cost: 2500, price: 5000, startStock: 20, stock: 17, minStock: 5, active: true, image: 'data:image/jpeg;base64,AAAA' },
          { id: 'P021', name: 'Face painting (small design)', categoryId: 'C5', cost: 500, price: 3000, startStock: 0, stock: 0, minStock: 0, active: true, image: null, service: true },
          { id: 'P099', name: 'Unpriced', categoryId: 'C1', cost: 100, price: null, stock: 3, minStock: 1, active: false },
        ],
        txns: [{ id: 'BZ-0001' }],
        users: [{ id: 'U1' }],
      },
    };
    const { rows, warnings, source } = parseProductsFile(JSON.stringify(backup));
    expect(source).toBe('legacy-backup');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ section_code: 'BAZAAR', category: 'Accessories', name: 'Phone charms', sku: 'P001', price: 50, cost: 25, stock: 17, min_stock: 5, track_stock: true, active: true, image_data_url: 'data:image/jpeg;base64,AAAA' });
    expect(rows[1]).toMatchObject({ track_stock: false, stock: 0, price: 30, cost: 5, category: 'Services' });
    expect(rows[2]).toMatchObject({ price: 0, active: false });
    expect(warnings.join(' ')).toMatch(/1 old transaction/);
    expect(warnings.join(' ')).toMatch(/Unpriced/);
  });

  it('reads CSV including quoted fields', () => {
    const rows = parseCSV('name,price\r\n"Pens, blue",5\r\n"Say ""hi""",2\r\n');
    expect(rows).toEqual([{ name: 'Pens, blue', price: '5' }, { name: 'Say "hi"', price: '2' }]);
    const r = parseProductsFile(CSV_TEMPLATE, { defaultSection: 'BAZAAR' });
    expect(r.rows).toHaveLength(3);
    expect(r.rows[1]).toMatchObject({ section_code: 'SNACKS', name: 'Water bottle', price: 10, stock: 48 });
    expect(r.rows[2]).toMatchObject({ track_stock: false, stock: 0 });
  });

  it('the original HTML POS seed products match the SQL catalogue seed', () => {
    const sql = readFileSync(new URL('../../supabase/data/bazaar_catalog_from_original_pos.sql', import.meta.url), 'utf8');
    for (const name of ['Phone charms', 'Caps', "Rubik''s cubes", 'Face painting (full face)']) expect(sql).toContain(name);
  });

  it('rejects junk', () => {
    expect(parseProductsFile('{oops').warnings[0]).toMatch(/not valid JSON/);
    expect(parseProductsFile('{"x":1}').rows).toEqual([]);
    expect(parseProductsFile('').rows).toEqual([]);
  });
});
