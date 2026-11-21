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
