import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { buildSchemaJobs } from './sqlSchemaJobs';

// Tree shape mirrors what get{Cap}SchemaTree returns (mysqlFamily LEFT JOIN,
// pg bridge equivalent): one entry per database/schema plus its tables/views.
const TREE = [
  { name: 'artsgo_com', tables: ['addresses', 'admin_users', 'brands'], views: [] },
  { name: 'csp_demo', tables: ['t_app', 't_hsm'], views: ['v_app_summary'] },
  { name: 'zlj2', tables: ['t_log'], views: [] },
];

test('mysql: selectedSchema scopes jobs to that database and qualifies every table with it', () => {
  // Regression: ER/搜索 built mysql jobs with schema:null and no scoping, so
  // tableMeta ran unqualified against the connection's default database —
  // "No database selected" without one, "Table 'db.wrongTable' doesn't
  // exist" with one. The tree's database name IS the SQL qualifier here.
  const jobs = buildSchemaJobs('mysql', TREE, 'csp_demo');
  assert.deepEqual(jobs, [
    { schema: 'csp_demo', table: 't_app' },
    { schema: 'csp_demo', table: 't_hsm' },
  ]);
});

test('mysql: no selectedSchema keeps every database, schema still attached', () => {
  const jobs = buildSchemaJobs('mysql', TREE, undefined);
  assert.equal(jobs.length, 6);
  assert.ok(jobs.every((j) => j.schema && j.schema.length > 0));
  assert.deepEqual(
    jobs.filter((j) => j.table === 't_log'),
    [{ schema: 'zlj2', table: 't_log' }],
  );
});

test('mariadb behaves like mysql (same wire family)', () => {
  const jobs = buildSchemaJobs('mariadb', TREE, 'csp_demo');
  assert.deepEqual(jobs, [
    { schema: 'csp_demo', table: 't_app' },
    { schema: 'csp_demo', table: 't_hsm' },
  ]);
});

test('postgresql: selectedSchema filter and schema attach unchanged', () => {
  // fixture db names double as pg schemas here; only the matching one survives
  const scoped = buildSchemaJobs('postgresql', TREE, 'csp_demo');
  assert.deepEqual(scoped, [
    { schema: 'csp_demo', table: 't_app' },
    { schema: 'csp_demo', table: 't_hsm' },
  ]);
  const all = buildSchemaJobs('postgresql', TREE, undefined);
  assert.equal(all.length, 6);
  assert.ok(all.every((j) => j.schema !== null));
});

test('postgresql: no selectedSchema walks every schema', () => {
  const jobs = buildSchemaJobs('postgresql', TREE, undefined);
  assert.equal(jobs.length, 6);
});

test('sqlite: single implicit database, schema stays null, no filtering', () => {
  const jobs = buildSchemaJobs('sqlite', TREE, 'csp_demo');
  assert.equal(jobs.length, 6);
  assert.ok(jobs.every((j) => j.schema === null));
});

test('views only participate when requested (ER wants tables only)', () => {
  const noViews = buildSchemaJobs('mysql', TREE, 'csp_demo');
  assert.deepEqual(noViews.map((j) => j.table), ['t_app', 't_hsm']);
  const withViews = buildSchemaJobs('mysql', TREE, 'csp_demo', { includeViews: true });
  assert.deepEqual(withViews.map((j) => j.table), ['t_app', 't_hsm', 'v_app_summary']);
});

test('empty database entries produce no jobs', () => {
  const jobs = buildSchemaJobs('mysql', [{ name: 'empty_db', tables: [], views: [] }], undefined);
  assert.deepEqual(jobs, []);
});

test('both panels build jobs through the shared builder', () => {
  for (const file of ['SqlErdPanel.tsx', 'SqlSearchPanel.tsx']) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.match(source, /buildSchemaJobs\(/, file);
    // the old inline pattern that dropped mysql qualifiers must stay gone
    assert.doesNotMatch(source, /schemaQualified \? db\.name : null/, file);
  }
});
