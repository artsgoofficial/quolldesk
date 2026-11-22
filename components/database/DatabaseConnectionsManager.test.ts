import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { sqlBadgeLabel } from './DatabaseConnectionsManager';

test('badge label comes from the engine registry for every sql engine', () => {
  assert.equal(sqlBadgeLabel('mysql'), 'MySQL');
  assert.equal(sqlBadgeLabel('postgresql'), 'PostgreSQL');
  assert.equal(sqlBadgeLabel('mariadb'), 'MariaDB');
  assert.equal(sqlBadgeLabel('mssql'), 'SQL Server');
  assert.equal(sqlBadgeLabel('sqlite'), 'SQLite');
});

test('badge label falls back to SQL for non-sql protocols', () => {
  assert.equal(sqlBadgeLabel('redis'), 'SQL');
  assert.equal(sqlBadgeLabel('ssh'), 'SQL');
  assert.equal(sqlBadgeLabel(undefined), 'SQL');
});

test('the SQL section groups by engine (no per-row badge) and passes the dialect through', () => {
  const source = readFileSync(new URL('./DatabaseConnectionsManager.tsx', import.meta.url), 'utf8');
  // Engine identity moved to the group header (DbConnectionsManager grouping);
  // the per-row badge prop is retired.
  assert.doesNotMatch(source, /badgeLabel=/);
  assert.doesNotMatch(source, /host\.protocol === 'postgresql' \? 'PostgreSQL' : 'MySQL'/);
  assert.match(source, /section="databases"/);
  assert.match(source, /dialect=\{dialect\}/);
});
