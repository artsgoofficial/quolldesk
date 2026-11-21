import { describe } from 'node:test';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDbProtocol, DB_DEFAULT_PORTS,
  normalizeRedisConfig, normalizeSqlConfig, hostsForDbSection, filterOutDbHosts,
  resolveDbSessionTabStatus,
} from './database';

describe('db protocol helpers', () => {
  it('classifies protocols', () => {
    assert.equal(isDbProtocol('redis'), true);
    assert.equal(isDbProtocol('mysql'), true);
    assert.equal(isDbProtocol('postgresql'), true);
    assert.equal(isDbProtocol('ssh'), false);
    assert.equal(isDbProtocol(undefined), false);
  });
  it('exposes default ports', () => {
    assert.deepEqual(DB_DEFAULT_PORTS, {
      redis: 6379, mysql: 3306, postgresql: 5432, mariadb: 3306, mssql: 1433, sqlite: null,
    });
  });
});

describe('normalizeRedisConfig', () => {
  it('keeps valid fields and drops invalid', () => {
    const cfg = normalizeRedisConfig({ redisDb: 3, redisUsername: ' default', cluster: true, bogus: 'x' });
    assert.deepEqual(cfg, { redisDb: 3, redisUsername: 'default', cluster: true });
    assert.equal(normalizeRedisConfig({ redisDb: 16 })?.redisDb, undefined);
    assert.equal(normalizeRedisConfig({ redisDb: -1 })?.redisDb, undefined);
    assert.equal(normalizeRedisConfig(null), undefined);
  });
  it('normalizes cluster nodes with dedupe', () => {
    const cfg = normalizeRedisConfig({
      cluster: true,
      clusterNodes: [
        { hostname: 'a', port: 6379 }, { hostname: 'a', port: 6379 },
        { hostname: '', port: 1 }, { hostname: 'b', port: 99999 },
      ],
    });
    assert.deepEqual(cfg?.clusterNodes, [{ hostname: 'a', port: 6379 }]);
  });
  it('ignores null cluster nodes', () => {
    const cfg = normalizeRedisConfig({ cluster: true, clusterNodes: [null] });
    assert.equal(cfg?.clusterNodes, undefined);
  });
  it('keeps tunnel/tls fields', () => {
    const cfg = normalizeRedisConfig({ tls: true, tlsInsecure: true, tunnelHostId: 'h1' });
    assert.deepEqual(cfg, { tls: true, tlsInsecure: true, tunnelHostId: 'h1' });
  });
});

describe('normalizeSqlConfig', () => {
  it('keeps database and tunnel fields, drops junk', () => {
    const cfg = normalizeSqlConfig({ database: 'app', tls: false, junk: 1 });
    assert.deepEqual(cfg, { database: 'app', tls: false });
    assert.equal(normalizeSqlConfig(undefined), undefined);
  });
  it('persists the sqlite read-only flag only as a boolean', () => {
    assert.equal(normalizeSqlConfig({ filePath: '/tmp/a.db', readOnly: true })?.readOnly, true);
    assert.equal(normalizeSqlConfig({ readOnly: false })?.readOnly, false);
    assert.equal(normalizeSqlConfig({ readOnly: 'yes' })?.readOnly, undefined);
    assert.equal(normalizeSqlConfig({})?.readOnly, undefined);
  });
  it('keeps the sqlite file path trimmed', () => {
    assert.equal(normalizeSqlConfig({ filePath: ' /tmp/a.db ' })?.filePath, '/tmp/a.db');
    assert.equal(normalizeSqlConfig({ filePath: '   ' })?.filePath, undefined);
  });
});

describe('resolveDbSessionTabStatus', () => {
  it('maps workbench status onto session tab status', () => {
    assert.equal(resolveDbSessionTabStatus('connecting'), 'connecting');
    assert.equal(resolveDbSessionTabStatus('connected'), 'connected');
    assert.equal(resolveDbSessionTabStatus('error'), 'disconnected');
    assert.equal(resolveDbSessionTabStatus('disconnected'), 'disconnected');
  });
  it('returns null for idle so the session keeps its current status', () => {
    // Fresh tabs are created 'connecting' (autoConnect follows immediately);
    // restored tabs keep 'disconnected' until the user reconnects.
    assert.equal(resolveDbSessionTabStatus('idle'), null);
  });
});

describe('section filters', () => {
  const hosts = [
    { id: '1', protocol: 'ssh' }, { id: '2', protocol: 'redis' },
    { id: '3', protocol: 'mysql' }, { id: '4', protocol: 'postgresql' },
    { id: '5', protocol: undefined },
  ];
  it('splits sections', () => {
    const typedHosts = hosts as { id: string; protocol: import('./database').DbProtocol | 'ssh' | undefined }[];
    assert.deepEqual(hostsForDbSection(typedHosts, 'redis').map(h => h.id), ['2']);
    assert.deepEqual(hostsForDbSection(typedHosts, 'databases').map(h => h.id), ['3', '4']);
  });
  it('filters db hosts out of the ssh list', () => {
    const typedHosts = hosts as { id: string; protocol: import('./database').DbProtocol | 'ssh' | undefined }[];
    assert.deepEqual(filterOutDbHosts(typedHosts).map(h => h.id), ['1', '5']);
  });
});
