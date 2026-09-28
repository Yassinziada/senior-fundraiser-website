// CSV export helpers (Excel-friendly: UTF-8 BOM, CRLF, quoted cells).

/** Protect against spreadsheet formula injection (=, +, -, @ at the start of text). */
function cell(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'number' ? String(v) : String(v);
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * rows: array of objects; columns: [{ key, label, value?: (row) => any }]
 */
export function toCSV(rows, columns) {
  const header = columns.map((c) => cell(c.label ?? c.key)).join(',');
  const body = rows.map((r) => columns.map((c) => cell(c.value ? c.value(r) : r[c.key])).join(','));
  return '﻿' + [header, ...body].join('\r\n');
}

export function downloadFile(filename, content, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}

export function exportCSV(filenameBase, rows, columns) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  downloadFile(`${filenameBase}_${stamp}.csv`, toCSV(rows, columns));
}
