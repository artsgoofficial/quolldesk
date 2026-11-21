/** Export helpers for workbench grids: Excel-friendly CSV, JSON objects, SQL INSERTs. */

const triggerDownload = (filename: string, content: string, mime: string): void => {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
};

const csvEscapeCell = (value: unknown): string => {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** CSV export (UTF-8 BOM + CRLF so Excel opens it directly). */
export function downloadCsv(filename: string, columns: string[], rows: unknown[][]): void {
  const lines = [columns.map(csvEscapeCell).join(','), ...rows.map((row) => row.map(csvEscapeCell).join(','))];
  triggerDownload(filename, '\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8');
}

/** JSON export: one object per row keyed by column name; NULL cells become null. */
export function downloadJson(filename: string, columns: string[], rows: unknown[][]): void {
  const objects = rows.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((column, i) => {
      obj[column] = row[i] ?? null;
    });
    return obj;
  });
  triggerDownload(filename, `${JSON.stringify(objects, null, 2)}\n`, 'application/json;charset=utf-8');
}

const sqlLiteral = (value: unknown): string =>
  value == null ? 'NULL' : `'${String(value).replace(/'/g, "''")}'`;

/** SQL INSERT export: one statement per row, single-quote-escaped, NULL for null. */
export function downloadInserts(filename: string, tableName: string, columns: string[], rows: unknown[][]): void {
  const statements = rows.map((row) =>
    `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${row.map(sqlLiteral).join(', ')});`);
  triggerDownload(filename, `${statements.join('\n')}\n`, 'text/plain;charset=utf-8');
}
