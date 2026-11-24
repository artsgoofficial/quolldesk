import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('the SQL section groups by engine (no per-row badge) and passes the dialect through', () => {
  const source = readFileSync(new URL('./DatabaseConnectionsManager.tsx', import.meta.url), 'utf8');
  // Engine identity moved to the group header (DbConnectionsManager grouping);
  // the per-row badge prop is retired.
  assert.doesNotMatch(source, /badgeLabel=/);
  assert.doesNotMatch(source, /host\.protocol === 'postgresql' \? 'PostgreSQL' : 'MySQL'/);
  assert.match(source, /section="databases"/);
  assert.match(source, /dialect=\{dialect\}/);
});
