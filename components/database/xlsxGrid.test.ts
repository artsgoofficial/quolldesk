import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { readXlsxRows, toXlsxRows, xlsxFileName } from './xlsxGrid';

test('toXlsxRows prepends the header and nulls become empty cells', () => {
  const rows = toXlsxRows(['id', 'note'], [[1, 'a'], [2, null]]);
  assert.deepEqual(rows, [
    ['id', 'note'],
    [1, 'a'],
    [2, null],
  ]);
});

test('xlsx round-trip: exported rows read back identically as strings', async () => {
  const XLSX = await import('xlsx');
  const columns = ['id', 'note'];
  const rows: unknown[][] = [[1, 'alpha'], [2, 'beta, with comma'], [3, null]];
  const sheet = XLSX.utils.aoa_to_sheet(toXlsxRows(columns, rows));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'data');
  const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  const parsed = await readXlsxRows(buffer);
  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed[0], ['id', 'note']);
  assert.equal(parsed[1][0], '1');
  assert.equal(parsed[2][1], 'beta, with comma');
  assert.equal(parsed[3][1], '');
});

test('readXlsxRows on an empty workbook yields an empty list', async () => {
  const XLSX = await import('xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[]]), 'data');
  const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  const parsed = await readXlsxRows(buffer);
  assert.deepEqual(parsed, []); // empty sheet → no rows at all
});

test('xlsxFileName appends the extension', () => {
  assert.equal(xlsxFileName('users-2026'), 'users-2026.xlsx');
});

test('SqlTableData offers an xlsx export entry and the wizard accepts .xlsx', () => {
  const grid = readFileSync(new URL('./SqlTableData.tsx', import.meta.url), 'utf8');
  assert.match(grid, /db\.export\.xlsx/);
  assert.match(grid, /downloadXlsx\(/);
  const wizard = readFileSync(new URL('./SqlImportWizard.tsx', import.meta.url), 'utf8');
  assert.match(wizard, /accept="\.csv,\.xlsx"/);
  assert.match(wizard, /readXlsxRows\(await file\.arrayBuffer\(\)\)/);
});
