import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { extractBindVariables, substituteBindVariables, toSqlLiteralValue } from './bindVariables';

test('extractBindVariables finds distinct ${name} tokens in first-appearance order', () => {
  const vars = extractBindVariables('select * from t where a = ${name} and b = ${limit} or a = ${name}');
  assert.deepEqual(vars, ['name', 'limit']);
});

test('blank and duplicate tokens are skipped', () => {
  assert.deepEqual(extractBindVariables('${} ${ } a = ${x} b = ${x}'), ['x']);
  assert.deepEqual(extractBindVariables('no tokens here'), []);
});

test('toSqlLiteralValue quotes and escapes; blank becomes NULL', () => {
  assert.equal(toSqlLiteralValue("O'k"), "'O''k'");
  assert.equal(toSqlLiteralValue('  '), 'NULL');
  assert.equal(toSqlLiteralValue('42'), "'42'");
});

test('substituteBindVariables replaces every occurrence with escaped literals', () => {
  const sql = "insert into t values (${name}, ${name}, ${ts})";
  const out = substituteBindVariables(sql, { name: "O'k", ts: '2026-01-01' });
  assert.equal(out, "insert into t values ('O''k', 'O''k', '2026-01-01')");
  // Unbound variables stay untouched.
  const partial = substituteBindVariables('${known} ${unknown}', { known: 'v' });
  assert.equal(partial, "'v' ${unknown}");
});

test('SqlQueryEditor wires the bind prompt into the run path', () => {
  const editor = readFileSync(new URL('./SqlQueryEditor.tsx', import.meta.url), 'utf8');
  assert.match(editor, /extractBindVariables\(sql\)/);
  assert.match(editor, /substituteBindVariables\(bindPrompt\.sql, bindValues\)/);
  assert.match(editor, /db\.query\.bindTitle/);
});
