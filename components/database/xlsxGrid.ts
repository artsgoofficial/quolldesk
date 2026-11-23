/**
 * XLSX import/export for workbench grids, on top of SheetJS. The library is
 * imported dynamically at both call sites so the ~1MB parser stays out of the
 * main bundle (CSV/JSON/INSERTS exports do not pay for it).
 */

type CellValue = string | number | boolean | null;

/** Trigger a browser download for binary xlsx content. */
const triggerBinaryDownload = (filename: string, data: ArrayBuffer): void => {
  const blob = new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
};

/** Grid values → xlsx cell: null becomes an empty cell, others pass through. */
export const toXlsxRows = (columns: string[], rows: unknown[][]): CellValue[][] =>
  [columns, ...rows.map((row) => row.map((v) => (v == null ? null : (v as CellValue))))];

/** Export rows as a single-sheet .xlsx (sheet name "data"). */
export const downloadXlsx = async (filename: string, columns: string[], rows: unknown[][]): Promise<void> => {
  const XLSX = await import('xlsx');
  const sheet = XLSX.utils.aoa_to_sheet(toXlsxRows(columns, rows));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'data');
  const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  triggerBinaryDownload(filename, buffer);
};

/**
 * Parse an .xlsx file into (header, rows) pairs — same shape the CSV import
 * wizard produces, so column mapping downstream is shared. Header row = first
 * sheet's first row; blank trailing rows are dropped.
 */
export const readXlsxRows = async (fileData: ArrayBuffer): Promise<string[][]> => {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(fileData, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: '' });
  return rows.map((row) => row.map((cell) => (cell == null ? '' : String(cell))));
};

/** Engine helper kept here so callers do not touch the engine id directly. */
export const xlsxFileName = (base: string): string => `${base}.xlsx`;
