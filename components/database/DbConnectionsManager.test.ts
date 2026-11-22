import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { SQL_ENGINES } from '../../domain/models/dbEngines';
import { dbRowAddressLine, groupSectionHosts, type DbHostGroup } from './DbConnectionsManager';
import type { Host } from '../../domain/models/connection';

const makeHost = (id: string, protocol: Host['protocol'], label?: string): Host =>
  ({ id, protocol, label, hostname: `${id}.host`, port: 3306, tags: [] } as unknown as Host);

test('picker offers the five registry engines with their labels', () => {
  assert.deepEqual(
    SQL_ENGINES.map((e) => e.label),
    ['MySQL', 'PostgreSQL', 'MariaDB', 'SQL Server', 'SQLite'],
  );
});

test('row address: file-backed engines show the path without a port suffix', () => {
  assert.equal(
    dbRowAddressLine({ hostname: '/tmp/data.db', port: undefined, protocol: 'sqlite' }),
    '/tmp/data.db',
  );
});

test('row address: hostPort sql engines and redis keep the hostname:port line', () => {
  assert.equal(dbRowAddressLine({ hostname: '10.0.0.1', port: 3306, protocol: 'mysql' }), '10.0.0.1:3306');
  assert.equal(dbRowAddressLine({ hostname: '10.0.0.2', port: 3306, protocol: 'mariadb' }), '10.0.0.2:3306');
  assert.equal(dbRowAddressLine({ hostname: '10.0.0.3', port: 1433, protocol: 'mssql' }), '10.0.0.3:1433');
  assert.equal(dbRowAddressLine({ hostname: '127.0.0.1', port: 6379, protocol: 'redis' }), '127.0.0.1:6379');
});

test('picker buttons come from the registry, not hardcoded label pairs', () => {
  const source = readFileSync(new URL('./DbConnectionsManager.tsx', import.meta.url), 'utf8');
  assert.match(source, /SQL_ENGINES\.map/);
  assert.match(source, /engine\.label/);
  assert.doesNotMatch(source, />MySQL<\/Button>/);
  assert.doesNotMatch(source, />PostgreSQL<\/Button>/);
});

test('dialect state is widened to SqlEngineId', () => {
  const source = readFileSync(new URL('./DbConnectionsManager.tsx', import.meta.url), 'utf8');
  assert.match(source, /import \{[^}]*SQL_ENGINES[^}]*isSqlEngineId[^}]*type SqlEngineId[^}]*\} from '\.\.\/\.\.\/domain\/models\/dbEngines'/);
  assert.match(source, /useState<SqlEngineId \| null>\(null\)/);
  assert.match(source, /useState<SqlEngineId>\('mysql'\)/);
});

test('edit routing resolves the details-panel dialect from the edited host', () => {
  const source = readFileSync(new URL('./DbConnectionsManager.tsx', import.meta.url), 'utf8');
  assert.match(source, /resolveSqlEngineForEdit\(editing, newDialect\)/);
  assert.doesNotMatch(source, /protocol === 'postgresql' \? 'postgresql' : 'mysql'/);
});

test('row rendering uses the address helper before the meta line', () => {
  const source = readFileSync(new URL('./DbConnectionsManager.tsx', import.meta.url), 'utf8');
  assert.match(source, /\{dbRowAddressLine\(host\)\}\{metaLine\(host\)\}/);
  assert.doesNotMatch(source, /\{host\.hostname\}:\{host\.port\}/);
});

test('databases section groups by engine in registry order, empty groups dropped', () => {
  const hosts = [
    makeHost('a', 'sqlite', 'zz-file'),
    makeHost('b', 'mysql', 'b-mysql'),
    makeHost('c', 'mssql', 'c-mssql'),
    makeHost('d', 'mysql', 'a-mysql'),
    makeHost('e', 'redis', 'not-in-this-section'),
  ];
  const groups: DbHostGroup[] | null = groupSectionHosts('databases', hosts);
  assert.deepEqual(groups?.map((g) => g.engine.id), ['mysql', 'mssql', 'sqlite']);
  assert.deepEqual(groups?.[0].hosts.map((h) => h.label), ['a-mysql', 'b-mysql']);
});

test('redis section renders flat (no grouping)', () => {
  assert.equal(groupSectionHosts('redis', [makeHost('r', 'redis')]), null);
});

test('grouped cards: vault card language + engine accent header + hover actions', () => {
  const source = readFileSync(new URL('./DbConnectionsManager.tsx', import.meta.url), 'utf8');
  assert.match(source, /group\/row/);
  assert.match(source, /group-hover\/row:opacity-100/);
  assert.match(source, /focus-within:opacity-100/);
  assert.match(source, /soft-card elevate rounded-xl/);
  assert.match(source, /grid-cols-\[repeat\(auto-fill,minmax\(230px,1fr\)\)\]/);
  assert.match(source, /backgroundColor: engine\.accent/);
  assert.match(source, /color: engine\.accent/);
  assert.match(source, /backgroundColor: rowAccent\(host\)/);
  assert.doesNotMatch(source, /<Badge variant="outline">/);
});
