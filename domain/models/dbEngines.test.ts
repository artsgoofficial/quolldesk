import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQL_ENGINES, SQL_ENGINE_BY_ID, isSqlEngineId, sqlQuoteIdent } from './dbEngines';
import { DB_DEFAULT_PORTS, isDbProtocol, hostsForDbSection } from './database';

test('registry: 5 engines in picker order with caps matching preload naming', () => {
  assert.deepEqual(SQL_ENGINES.map((e) => e.id), ['mysql', 'postgresql', 'mariadb', 'mssql', 'sqlite']);
  assert.deepEqual(SQL_ENGINES.map((e) => e.cap), ['Mysql', 'Pg', 'Mariadb', 'Mssql', 'Sqlite']);
});

test('registry: sqlite is file-based without tls/tunnel/index methods', () => {
  const s = SQL_ENGINE_BY_ID.sqlite;
  assert.equal(s.addressMode, 'file');
  assert.equal(s.defaultPort, null);
  assert.equal(s.features.tls, false);
  assert.equal(s.features.indexMethods.length, 0);
  assert.equal(SQL_ENGINE_BY_ID.mssql.defaultPort, 1433);
  assert.equal(SQL_ENGINE_BY_ID.mariadb.defaultPort, 3306);
});

test('registry: sqlQuoteIdent per engine', () => {
  assert.equal(sqlQuoteIdent('mysql', 'a`b'), '`a``b`');
  assert.equal(sqlQuoteIdent('mariadb', 'x'), '`x`');
  assert.equal(sqlQuoteIdent('postgresql', 'a"b'), '"a""b"');
  assert.equal(sqlQuoteIdent('sqlite', 'x'), '"x"');
  assert.equal(sqlQuoteIdent('mssql', 'a]b'), '[a]]b]');
});

test('db protocol: new engines recognized and sectioned', () => {
  for (const p of ['mariadb', 'mssql', 'sqlite'] as const) assert.equal(isDbProtocol(p), true);
  assert.equal(DB_DEFAULT_PORTS.sqlite, null);
  const hosts = [
    { protocol: 'mariadb' }, { protocol: 'mssql' }, { protocol: 'sqlite' }, { protocol: 'ssh' },
  ] as never[];
  assert.equal(hostsForDbSection(hosts, 'databases').length, 3);
});

test('registry: mssql advertises no tunnel (tedious cannot inject sockets — Ruling 8)', () => {
  assert.equal(SQL_ENGINE_BY_ID.mssql.features.tunnel, false);
  assert.equal(SQL_ENGINE_BY_ID.mssql.features.tls, true);
});

test('registry: per-engine form placeholders (mssql sa/master)', () => {
  assert.equal(SQL_ENGINE_BY_ID.mssql.placeholderUsername, 'sa');
  assert.equal(SQL_ENGINE_BY_ID.mssql.placeholderDatabase, 'master');
  // Every hostPort engine shows meaningful hints; sqlite hides both rows.
  for (const id of ['mysql', 'postgresql', 'mariadb'] as const) {
    assert.ok(SQL_ENGINE_BY_ID[id].placeholderUsername.length > 0, `${id} username hint`);
    assert.ok(SQL_ENGINE_BY_ID[id].placeholderDatabase.length > 0, `${id} database hint`);
  }
  assert.equal(SQL_ENGINE_BY_ID.sqlite.placeholderUsername, '');
  assert.equal(SQL_ENGINE_BY_ID.sqlite.placeholderDatabase, '');
});

test('registry: isSqlEngineId rejects inherited Object.prototype keys', () => {
  // SQL_ENGINE_BY_ID is built with Object.fromEntries (plain prototype);
  // `in` would let 'constructor'/'toString'/'__proto__' pass the guard.
  assert.equal(isSqlEngineId('constructor'), false);
  assert.equal(isSqlEngineId('toString'), false);
  assert.equal(isSqlEngineId('__proto__'), false);
  assert.equal(isSqlEngineId('hasOwnProperty'), false);
  assert.equal(isSqlEngineId('mysql'), true);
  assert.equal(isSqlEngineId('sqlite'), true);
});
