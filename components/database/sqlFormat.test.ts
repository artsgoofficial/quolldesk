import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { formatSql, SQL_FORMAT_LANGUAGE } from './sqlFormat';

test('dialect mapping covers every engine (mssql = transactsql)', () => {
  assert.equal(SQL_FORMAT_LANGUAGE.mysql, 'mysql');
  assert.equal(SQL_FORMAT_LANGUAGE.mariadb, 'mariadb');
  assert.equal(SQL_FORMAT_LANGUAGE.postgresql, 'postgresql');
  assert.equal(SQL_FORMAT_LANGUAGE.mssql, 'transactsql');
  assert.equal(SQL_FORMAT_LANGUAGE.sqlite, 'sqlite');
});

test('formats lowercase sql with upper keywords and 2-space indent (pg)', () => {
  const out = formatSql('postgresql', 'select a,b from t where a=1');
  assert.match(out, /SELECT\n {2}a,\n {2}b\nFROM\n {2}t\nWHERE\n {2}a = 1/);
});

test('mysql backtick identifiers and keywords survive formatting', () => {
  const out = formatSql('mysql', 'select `col a`, count(*) from `my table` group by `col a`');
  assert.match(out, /SELECT/);
  assert.match(out, /`col a`/);
  assert.match(out, /`my table`/);
  assert.match(out, /GROUP BY/);
});

test('tsql dialect formats bracket identifiers (mssql)', () => {
  const out = formatSql('mssql', 'select top 5 [col x] from [dbo].[t] order by [col x]');
  assert.match(out, /\[col x\]/);
  assert.match(out, /ORDER BY/);
});

test('empty and whitespace-only sql pass through untouched', () => {
  assert.equal(formatSql('postgresql', ''), '');
  assert.equal(formatSql('postgresql', '   \n  '), '   \n  ');
});

test('formatting is idempotent on already-formatted sql', () => {
  const once = formatSql('postgresql', 'select a from t where a = 1');
  assert.equal(formatSql('postgresql', once), once);
});

test('the query editor wires a format button and the Shift+Alt+F monaco command', () => {
  const source = readFileSync(new URL('./SqlQueryEditor.tsx', import.meta.url), 'utf8');
  // Toolbar button (i18n label) + pure helper call scoped to the editor model.
  assert.match(source, /db\.query\.format/);
  assert.match(source, /formatSql\(dialect, model\.getValue\(\)\)/);
  // Undo-friendly replacement through executeEdits (not setValue — that
  // destroys the undo stack).
  assert.match(source, /executeEdits\('sql-format'/);
  // In-editor shortcut (monaco swallows keydown): Shift+Alt+F.
  assert.match(source, /KeyMod\.Shift \| monacoInstance\.KeyMod\.Alt \| monacoInstance\.KeyCode\.KeyF/);
});
