import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./SqlTableData.tsx', import.meta.url), 'utf8');

test('grid export: all formats wired including xlsx with success toast', () => {
  // The dropdown maps over EXPORT_ITEMS — every format is one entry driving
  // both the menu row and the trigger label.
  assert.match(source, /EXPORT_ITEMS\.map\(\(\{ fmt, label \}\) =>/);
  assert.match(source, /setExportFormat\(fmt\); exportData\(fmt\);/);
  for (const label of ['db.grid.exportCsv', 'db.export.json', 'db.export.inserts', 'db.export.xlsx']) {
    assert.match(source, new RegExp(`fmt: '(csv|json|inserts|xlsx)', label: '${label.replace(/\./g, '\\.')}'`), label);
  }
  assert.match(source, /downloadXlsx\(/);
  assert.match(source, /db\.grid\.exported/);
  assert.match(source, /db\.grid\.exportFailed/);
});

test('aggregate footer: header click toggles aggregation, numeric stats render', () => {
  assert.match(source, /setAggregateColumn\(\(prev\) => \(prev === c\.name \? null : c\.name\)\)/);
  assert.match(source, /data-testid="aggregate-footer"/);
  assert.match(source, /aggregate\.numeric/);
  assert.match(source, /db\.grid\.aggregateHint/);
  assert.match(source, /db\.aggregate\.sum/);
});

test('record mode: row detail button opens a form dialog saving via pendingUpdates', () => {
  assert.match(source, /recordRowKey/);
  assert.match(source, /db\.grid\.recordDetail/);
  assert.match(source, /db\.grid\.recordTitle/);
  // saves reuse the exact pendingUpdates contract (cellKey + pk payload)
  assert.match(source, /next\[key\] = \{ pk: pkColumn, pkValue: recordRowKey, column: c\.name, value: change\.isNull \? null : change\.value \};/);
});
