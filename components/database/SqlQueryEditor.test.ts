import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { SQL_ENGINE_BY_ID } from '../../domain/models/dbEngines';

const source = readFileSync(new URL('./SqlQueryEditor.tsx', import.meta.url), 'utf8');

test('query editor accepts an optional tree-driven seed query', () => {
  assert.match(source, /seedQuery\?: \{ sql: string; token: number \}/);
});

test('a changed seed token opens a new tab with the seeded sql and activates it', () => {
  assert.match(source, /seededTokenRef/);
  // Guard: same token never seeds twice (the editor remounts on tab switches).
  assert.match(source, /seedQuery\.token !== seededTokenRef\.current/);
  // Seeding goes through the same tab-creation shape as addTab.
  assert.match(source, /sql: seedQuery\.sql/);
  assert.match(source, /setTabs\(\(prev\) => \[\.\.\.prev, tab\]\);\s*\n\s*setActiveTabId\(tab\.id\)/);
});

// ——— engine-id threading (Task 9) ——————————————————————————————————————

test('the editor takes a SqlEngineId and reads monaco language from the registry', () => {
  assert.match(source, /dialect: SqlEngineId/);
  assert.match(source, /SQL_ENGINE_BY_ID\[dialect\]\.monacoLanguage/);
  assert.ok(!source.includes('dialectToMonacoLanguage'), 'the two-dialect mapper must be gone');
});

test('history and favorites are persisted per engine id', () => {
  // One storage key, a slot per engine id (existing mysql/pg slots preserved).
  // Per-engine read/write: slots are keyed by engine id, missing slots (older
  // snapshots, new engines) fall back to empty lists per key.
  assert.match(source, /history\[dialect\]/);
  assert.match(source, /favorites\[dialect\]/);
  assert.match(source, /Object\.fromEntries\(SQL_ENGINES\.map\(\(e\) => \[e\.id, keepStrings\(stored\[e\.id\]\)\]\)\) as EngineQueryLists/);
  const usesOldTwoDialectShape = /DialectQueryLists/.test(source);
  assert.ok(!usesOldTwoDialectShape, 'the { mysql, postgresql } shape must be engine-generic');
});

test('the query call carries timeoutMs only for engines whose registry flag says the bridge honors it', () => {
  // Registry-driven gate (features.queryTimeout) + spread form: pg/sqlite
  // calls stay arg-for-arg identical to before.
  assert.match(source, /features\.queryTimeout \? \{ timeoutMs: QUERY_TIMEOUT_MS \} : \{\}/);
  assert.match(source, /timeoutMs: QUERY_TIMEOUT_MS/);
  // The flag itself is registry data (mysql family + mssql true; pg/sqlite false).
  for (const [engine, expected] of [
    ['mysql', true], ['mariadb', true], ['mssql', true], ['postgresql', false], ['sqlite', false],
  ] as const) {
    assert.equal(SQL_ENGINE_BY_ID[engine].features.queryTimeout, expected, engine);
  }
});
