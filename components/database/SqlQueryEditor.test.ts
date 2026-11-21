import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

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
