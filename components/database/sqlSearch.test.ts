import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  buildProbeSql, matchesTerm, textLikeColumns, type SearchColumnMeta,
} from './sqlSearch';

const col = (name: string, type: string): SearchColumnMeta => ({ name, dataType: type });

test('matchesTerm is case-insensitive and trims the term', () => {
  assert.equal(matchesTerm('Satms_Users', '  satms '), true);
  assert.equal(matchesTerm('users', 'ATMS'), false);
  assert.equal(matchesTerm('', 'x'), false);
});

test('textLikeColumns keeps character/text/json families only', () => {
  const cols = [
    col('name', 'character varying'),
    col('doc', 'jsonb'),
    col('body', 'text'),
    col('n', 'integer'),
    col('ts', 'timestamp'),
    col('c', 'char(4)'),
    col('nv', 'nvarchar(255)'),
  ];
  const names = textLikeColumns(cols, 'postgresql').map((c) => c.name);
  assert.deepEqual(names, ['name', 'doc', 'body', 'c', 'nv']);
});

test('pg probe: parameterized ILIKE with ::text cast, ESCAPE clause, $1 placeholder', () => {
  const { sql, values } = buildProbeSql('postgresql', '"public"."t"', ['name', 'doc'], 'ab%', 3);
  assert.match(sql, /SELECT \* FROM "public"\."t" WHERE/);
  assert.match(sql, /"name"::text ILIKE \$1 ESCAPE '\\'/);
  assert.match(sql, /"doc"::text ILIKE \$1 ESCAPE '\\'/);
  assert.match(sql, /LIMIT 3/);
  // term wildcards are escaped: "ab%" matches the literal text
  assert.deepEqual(values, ['%ab\\%%']);
});

test('probe escapes LIKE wildcards in the term (literal search)', () => {
  const { values } = buildProbeSql('sqlite', '"t"', ['a'], '100_%', 1);
  // term escapes to 100\_% , wrapped in literal percents: %100\_\%%
  assert.deepEqual(values, ['%100\\_\\%%']);
});

test('mysql probe: backtick columns and ? placeholder', () => {
  const { sql, values } = buildProbeSql('mysql', '`mydb`.`t`', ['a', 'b'], "O'k", 5);
  assert.match(sql, /`a` LIKE \? ESCAPE '.*' OR `b` LIKE \? ESCAPE '.*'/);
  assert.match(sql, /LIMIT 5/);
  assert.deepEqual(values, ["%O'k%"]);
});

test('sqlite probe: double-quoted columns, ESCAPE clause', () => {
  const { sql, values } = buildProbeSql('sqlite', '"main"."t"', ['a'], 'x', 1);
  assert.equal(sql, 'SELECT * FROM "main"."t" WHERE "a" LIKE ? ESCAPE \'\\\' LIMIT 1');
  assert.deepEqual(values, ['%x%']);
});

test('mssql probe uses TOP wrapper with @0 parameter (T-SQL has no LIMIT)', () => {
  const { sql, values } = buildProbeSql('mssql', '[dbo].[t]', ['a'], 'x', 2);
  assert.match(sql, /SELECT TOP 2 \* FROM \[dbo\]\.\[t\] WHERE \[a\] LIKE @0 ESCAPE '\\'/);
  assert.ok(!sql.includes('LIMIT'));
  assert.deepEqual(values, ['%x%']);
});

test('empty column list yields null (caller skips the table)', () => {
  assert.equal(buildProbeSql('postgresql', '"t"', [], 'x', 3), null);
});

test('the search panel wires tree entry, caps, cancel and data hits', () => {
  const panel = readFileSync(new URL('./SqlSearchPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /MAX_TABLES = 200/);
  assert.match(panel, /PROBE_ROWS = 3/);
  assert.match(panel, /cancelledRef/);
  assert.match(panel, /fetchSqlSchemaTree/);
  assert.match(panel, /db\.search\.progress/);
  const tree = readFileSync(new URL('./SqlSchemaTree.tsx', import.meta.url), 'utf8');
  assert.match(tree, /onOpenSearch/);
  const workbench = readFileSync(new URL('./DatabaseWorkbench.tsx', import.meta.url), 'utf8');
  assert.match(workbench, /SqlSearchPanel/);
});

test('transfer panel: self-managed target connection, parameterized inserts, progress', () => {
  const panel = readFileSync(new URL('./SqlTransferPanel.tsx', import.meta.url), 'utf8');
  // Target connection lifecycle is self-managed (connect → transfer → disconnect).
  assert.match(panel, /\.disconnect\(targetId\)/);
  assert.match(panel, /resolveDbConnectArgs/);
  // Parameterized per dialect, never string-interpolated values.
  assert.match(panel, /param\(i\)/);
  assert.match(panel, /dialect === 'postgresql'/);
  assert.match(panel, /timeoutMs: 300000/);
  assert.match(panel, /TRANSFER_CANCELLED/);
  const menu = readFileSync(new URL('./DatabaseTreeContextMenus.tsx', import.meta.url), 'utf8');
  assert.match(menu, /onTransferTo/);
});
