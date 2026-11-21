import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { Host } from '../../domain/models/connection';
import { SQL_ENGINE_BY_ID } from '../../domain/models/dbEngines';
import {
  buildSqlHostPayload, resolveSqlEngineForEdit, type SqlHostFormState,
} from './SqlHostDetailsPanel';

const host = (overrides: Partial<Host> = {}): Host => ({
  id: 'host-1',
  label: 'db-1',
  hostname: '10.0.0.1',
  port: 3306,
  username: 'root',
  password: 'pw',
  savePassword: true,
  protocol: 'mysql',
  tags: [],
  os: 'linux',
  createdAt: 1,
  ...overrides,
});

const form = (overrides: Partial<SqlHostFormState> = {}): SqlHostFormState => ({
  label: 'db-1',
  hostname: '10.0.0.1',
  filePath: '',
  port: '3306',
  username: 'root',
  password: 'pw',
  savePassword: true,
  database: 'app',
  tls: false,
  tlsInsecure: false,
  tunnelHostId: '',
  readOnly: false,
  ...overrides,
});

test('edit resolution: the host protocol wins when it is a sql engine id', () => {
  assert.equal(resolveSqlEngineForEdit(host({ protocol: 'sqlite' }), 'mysql'), 'sqlite');
  assert.equal(resolveSqlEngineForEdit(host({ protocol: 'mariadb' }), 'mysql'), 'mariadb');
  assert.equal(resolveSqlEngineForEdit(host({ protocol: 'mssql' }), 'postgresql'), 'mssql');
  assert.equal(resolveSqlEngineForEdit(host({ protocol: 'postgresql' }), 'mysql'), 'postgresql');
  assert.equal(resolveSqlEngineForEdit(host({ protocol: 'mysql' }), 'postgresql'), 'mysql');
});

test('edit resolution: non-sql or missing protocols fall back to the picked dialect', () => {
  assert.equal(resolveSqlEngineForEdit(host({ protocol: 'redis' }), 'postgresql'), 'postgresql');
  assert.equal(resolveSqlEngineForEdit(host({ protocol: 'ssh' }), 'mysql'), 'mysql');
  assert.equal(resolveSqlEngineForEdit(undefined, 'mysql'), 'mysql');
  assert.equal(resolveSqlEngineForEdit(null, 'sqlite'), 'sqlite');
});

test('sqlite payload: hostname is the file path and the port is dropped', () => {
  const h = buildSqlHostPayload(SQL_ENGINE_BY_ID.sqlite, null, form({
    label: 'local db', hostname: '', port: '', filePath: '/tmp/data.db',
  }));
  assert.equal(h.protocol, 'sqlite');
  assert.equal(h.hostname, '/tmp/data.db');
  assert.equal(h.port, undefined);
  assert.equal(h.sqlConfig?.filePath, '/tmp/data.db');
});

test('sqlite payload: the read-only flag persists and can be unchecked', () => {
  const h = buildSqlHostPayload(SQL_ENGINE_BY_ID.sqlite, null, form({
    hostname: '', port: '', filePath: '/tmp/data.db', readOnly: true,
  }));
  assert.equal(h.sqlConfig?.readOnly, true);
  const reopened = buildSqlHostPayload(SQL_ENGINE_BY_ID.sqlite, h, form({
    hostname: '', port: '', filePath: '/tmp/data.db', readOnly: false,
  }));
  assert.equal(reopened.sqlConfig?.readOnly, false);
});

test('sqlite payload: no stale file path leaks when absent', () => {
  const h = buildSqlHostPayload(SQL_ENGINE_BY_ID.sqlite, null, form({
    hostname: '', port: '', filePath: '', database: '',
  }));
  assert.equal(h.sqlConfig?.filePath, undefined);
  assert.equal(h.sqlConfig?.database, undefined);
});

test('mysql payload: host/port/credentials behave exactly as before', () => {
  const h = buildSqlHostPayload(SQL_ENGINE_BY_ID.mysql, null, form());
  assert.equal(h.protocol, 'mysql');
  assert.equal(h.hostname, '10.0.0.1');
  assert.equal(h.port, 3306);
  assert.equal(h.username, 'root');
  assert.equal(h.password, 'pw');
  assert.equal(h.savePassword, true);
  assert.equal(h.sqlConfig?.database, 'app');
  assert.equal(h.sqlConfig?.filePath, undefined);
  // No serialization drift for hostPort engines: no readOnly key appears.
  assert.equal('readOnly' in (h.sqlConfig ?? {}), false);
});

test('mysql payload: unchecked save-password drops the stored password', () => {
  const h = buildSqlHostPayload(SQL_ENGINE_BY_ID.mysql, null, form({ savePassword: false }));
  assert.equal(h.password, undefined);
  assert.equal(h.savePassword, false);
});

test('pg payload: identity, label fallback, tls and tunnel survive an edit', () => {
  const editing = host({ id: 'keep-id', protocol: 'postgresql', sqlConfig: { tunnelHostId: 'h1' } });
  const h = buildSqlHostPayload(SQL_ENGINE_BY_ID.postgresql, editing, form({
    label: '', hostname: 'pg.internal', port: '5433',
    tls: true, tlsInsecure: true, tunnelHostId: 'h1', database: '',
  }));
  assert.equal(h.id, 'keep-id');
  assert.equal(h.protocol, 'postgresql');
  assert.equal(h.label, 'pg.internal');
  assert.equal(h.port, 5433);
  assert.deepEqual(h.sqlConfig, { tls: true, tlsInsecure: true, tunnelHostId: 'h1' });
});

test('mssql payload: engine id and port flow through the form', () => {
  const h = buildSqlHostPayload(SQL_ENGINE_BY_ID.mssql, null, form({ port: '1433', database: 'master' }));
  assert.equal(h.protocol, 'mssql');
  assert.equal(h.port, 1433);
  assert.equal(h.sqlConfig?.database, 'master');
});

test('form is registry-driven per engine descriptor', () => {
  const source = readFileSync(new URL('./SqlHostDetailsPanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /SQL_ENGINE_BY_ID/);
  assert.match(source, /isSqlEngineId/);
  assert.doesNotMatch(source, /type SqlDialect = /);
  // Port default comes from the descriptor, not the mysql/pg branch.
  assert.match(source, /engine\.defaultPort/);
  assert.doesNotMatch(source, /DB_DEFAULT_PORTS\[/);
});

test('sqlite form renders a database-file picker instead of host/port fields', () => {
  const source = readFileSync(new URL('./SqlHostDetailsPanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /db\.form\.databaseFile/);
  assert.match(source, /db\.form\.browse/);
  assert.match(source, /db\.form\.fileNewHint/);
  assert.match(source, /db\.form\.readOnlyOpen/);
  assert.match(source, /quolldeskBridge/);
  assert.match(source, /pickSqliteDatabaseFile/);
  assert.match(source, /\{ mode: 'open' \}/);
  // The picked path lands in a read-only input.
  assert.match(source, /id="sql-file" value=\{filePath\} readOnly/);
  // host/port grid and username/database rows are gated on the file mode.
  assert.match(source, /isFile \? \(/);
  assert.match(source, /\{!isFile && \(/);
});

test('feature rows render only when the descriptor enables them', () => {
  const source = readFileSync(new URL('./SqlHostDetailsPanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /engine\.features\.tls &&/);
  assert.match(source, /engine\.features\.tunnel &&/);
  // Ruling 8 UI side: the tunnel selector is feature-gated, not hardcoded.
  assert.match(source, /db\.form\.mssqlAuthHint/);
});
