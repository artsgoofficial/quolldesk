import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { overviewQueries } from './sqlOverview';

test('overview query sets exist for every engine with dialect-correct probes', () => {
  const engines = ['postgresql', 'mysql', 'mariadb', 'mssql', 'sqlite'] as const;
  for (const engine of engines) {
    const set = overviewQueries(engine);
    assert.ok(set.server.trim(), `${engine} server`);
    assert.ok(set.dbSize.trim(), `${engine} dbSize`);
    assert.ok(set.sessions.trim(), `${engine} sessions`);
    assert.ok(set.tables.trim(), `${engine} tables`);
  }
  assert.match(overviewQueries('postgresql').server, /version\(\)/);
  assert.match(overviewQueries('postgresql').dbSize, /pg_database_size\(current_database\(\)\)/);
  assert.match(overviewQueries('postgresql').tablesTop ?? '', /pg_total_relation_size/);
  assert.match(overviewQueries('mysql').dbSize, /information_schema\.tables/);
  assert.match(overviewQueries('mysql').sessions, /information_schema\.processlist/);
  assert.match(overviewQueries('sqlite').dbSize, /pragma_page_count/);
  // sqlite has no session concept — placeholder count.
  assert.equal(overviewQueries('sqlite').sessions, "SELECT '0' AS c");
  // mssql has no top-tables list in v1.
  assert.equal(overviewQueries('mssql').tablesTop, undefined);
});

test('SqlOverviewPanel runs the query set and renders cards plus top-tables', () => {
  const source = readFileSync(new URL('./SqlOverviewPanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /overviewQueries\(dialect\)/);
  assert.match(source, /db\.overview\.title/);
  assert.match(source, /tablesTop/);
  const workbench = readFileSync(new URL('./DatabaseWorkbench.tsx', import.meta.url), 'utf8');
  assert.match(workbench, /SqlOverviewPanel/);
  assert.match(workbench, /'overview'/);
});
