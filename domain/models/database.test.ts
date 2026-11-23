import { describe } from 'node:test';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDbProtocol, DB_DEFAULT_PORTS,
  normalizeRedisConfig, normalizeSqlConfig, hostsForDbSection, filterOutDbHosts,
  resolveDbSessionTabStatus,
  REDIS_DB_INDEX_MAX, isValidRedisDbIndex,
  buildDbConnectionString,
  REDIS_HOST_ACCENT, dbHostAccent,
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
    assert.equal(normalizeRedisConfig({ redisDb: -1 })?.redisDb, undefined);
    assert.equal(normalizeRedisConfig(null), undefined);
  });
  it('keeps indexes beyond the default 16 (servers may configure more logical DBs)', () => {
    // Redis SELECT accepts 0..databases-1 and `databases` is server config —
    // 16 is only the default. The sanitizer must not silently drop db16+.
    assert.equal(normalizeRedisConfig({ redisDb: 16 })?.redisDb, 16);
    assert.equal(normalizeRedisConfig({ redisDb: 32 })?.redisDb, 32);
    assert.equal(normalizeRedisConfig({ redisDb: 65535 })?.redisDb, 65535);
    assert.equal(normalizeRedisConfig({ redisDb: 65536 })?.redisDb, undefined);
    assert.equal(normalizeRedisConfig({ redisDb: 1.5 })?.redisDb, undefined);
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

describe('redis db index range', () => {
  it('exposes the shared UI guardrail: Redis default is 16, servers may configure far more', () => {
    assert.equal(REDIS_DB_INDEX_MAX, 65535);
    assert.equal(isValidRedisDbIndex(0), true);
    assert.equal(isValidRedisDbIndex(15), true);
    assert.equal(isValidRedisDbIndex(16), true);
    assert.equal(isValidRedisDbIndex(65535), true);
    assert.equal(isValidRedisDbIndex(65536), false);
    assert.equal(isValidRedisDbIndex(-1), false);
    assert.equal(isValidRedisDbIndex(1.5), false);
    assert.equal(isValidRedisDbIndex('3'), false);
    assert.equal(isValidRedisDbIndex(null), false);
  });
});

describe('buildDbConnectionString', () => {
  const base = { hostname: 'db.example.com' };

  it('returns null for non-db protocols', () => {
    assert.equal(buildDbConnectionString({ ...base, protocol: 'ssh' }), null);
    assert.equal(buildDbConnectionString({ ...base, protocol: undefined }), null);
    assert.equal(buildDbConnectionString({ ...base, protocol: 'plugin:demo' as never }), null);
    assert.equal(buildDbConnectionString({ ...base, protocol: 'telnet' }), null);
  });

  it('builds postgresql URLs with credentials, explicit port and database', () => {
    assert.equal(
      buildDbConnectionString({
        ...base, protocol: 'postgresql', username: 'alice', password: 'p@ss w:rd',
        port: 5433, sqlConfig: normalizeSqlConfig({ database: 'my db' }),
      }),
      'postgresql://alice:p%40ss%20w%3Ard@db.example.com:5433/my%20db',
    );
  });

  it('falls back to the engine default port when host.port is absent', () => {
    assert.equal(
      buildDbConnectionString({ ...base, protocol: 'postgresql', username: 'u' }),
      'postgresql://u@db.example.com:5432',
    );
    assert.equal(
      buildDbConnectionString({ ...base, protocol: 'mysql', username: 'u' }),
      'mysql://u@db.example.com:3306',
    );
    assert.equal(
      buildDbConnectionString({ ...base, protocol: 'mariadb', username: 'u' }),
      'mariadb://u@db.example.com:3306',
    );
    assert.equal(
      buildDbConnectionString({ ...base, protocol: 'mssql', username: 'u' }),
      'mssql://u@db.example.com:1433',
    );
  });

  it('appends the sql database path for host:port engines', () => {
    assert.equal(
      buildDbConnectionString({
        ...base, protocol: 'mysql', username: 'u', sqlConfig: normalizeSqlConfig({ database: 'shop' }),
      }),
      'mysql://u@db.example.com:3306/shop',
    );
    assert.equal(
      buildDbConnectionString({
        ...base, protocol: 'mssql', username: 'u', sqlConfig: normalizeSqlConfig({ database: 'master' }),
      }),
      'mssql://u@db.example.com:1433/master',
    );
  });

  it('builds redis URLs: password-only userinfo, rediss for tls, db index path', () => {
    assert.equal(
      buildDbConnectionString({ ...base, protocol: 'redis', password: 'secret' }),
      'redis://:secret@db.example.com:6379',
    );
    assert.equal(
      buildDbConnectionString({
        ...base, protocol: 'redis', password: 'secret',
        redisConfig: normalizeRedisConfig({ tls: true, redisDb: 3 }),
      }),
      'rediss://:secret@db.example.com:6379/3',
    );
    // db 0 is the default — no path segment
    assert.equal(
      buildDbConnectionString({
        ...base, protocol: 'redis', redisConfig: normalizeRedisConfig({ redisDb: 0 }),
      }),
      'redis://db.example.com:6379',
    );
  });

  it('prefers the redis ACL username, matching the bridge dial config', () => {
    assert.equal(
      buildDbConnectionString({
        ...base, protocol: 'redis', username: 'alice', password: 's',
        redisConfig: normalizeRedisConfig({ redisUsername: 'default' }),
      }),
      'redis://default:s@db.example.com:6379',
    );
    assert.equal(
      buildDbConnectionString({ ...base, protocol: 'redis', username: 'alice', password: 's' }),
      'redis://alice:s@db.example.com:6379',
    );
  });

  it('encodes special characters in username and password', () => {
    assert.equal(
      buildDbConnectionString({ ...base, protocol: 'postgresql', username: 'u@ser', password: 'p/a&ss' }),
      'postgresql://u%40ser:p%2Fa%26ss@db.example.com:5432',
    );
  });

  it('brackets IPv6 hosts', () => {
    assert.equal(
      buildDbConnectionString({ hostname: '::1', protocol: 'postgresql', username: 'u' }),
      'postgresql://u@[::1]:5432',
    );
  });

  it('keeps already-bracketed IPv6 hosts intact', () => {
    assert.equal(
      buildDbConnectionString({ hostname: '[::1]', protocol: 'postgresql', username: 'u' }),
      'postgresql://u@[::1]:5432',
    );
  });

  it('omits userinfo entirely when neither username nor password is set', () => {
    assert.equal(
      buildDbConnectionString({ ...base, protocol: 'postgresql' }),
      'postgresql://db.example.com:5432',
    );
  });

  it('builds sqlite file URLs from sqlConfig.filePath', () => {
    assert.equal(
      buildDbConnectionString({ hostname: '', protocol: 'sqlite', sqlConfig: normalizeSqlConfig({ filePath: '/data/app.db' }) }),
      'sqlite:///data/app.db',
    );
    assert.equal(
      buildDbConnectionString({ hostname: '', protocol: 'sqlite', sqlConfig: normalizeSqlConfig({ filePath: 'relative.db' }) }),
      'sqlite:///relative.db',
    );
    // no path configured → not a usable connection string
    assert.equal(
      buildDbConnectionString({ hostname: '', protocol: 'sqlite' }),
      null,
    );
  });
});

describe('dbHostAccent', () => {
  it('returns the registry accent for sql engines and brand red for redis', () => {
    assert.equal(dbHostAccent('redis'), REDIS_HOST_ACCENT);
    assert.equal(dbHostAccent('redis'), '#D44B4B');
    assert.equal(dbHostAccent('mysql'), '#1E7BA8');
    assert.equal(dbHostAccent('postgresql'), '#336791');
    assert.equal(dbHostAccent('mariadb'), '#A2593C');
    assert.equal(dbHostAccent('mssql'), '#A93038');
    assert.equal(dbHostAccent('sqlite'), '#0F7B6C');
  });
  it('returns null for non-db protocols so hosts keep their own avatar', () => {
    assert.equal(dbHostAccent('ssh'), null);
    assert.equal(dbHostAccent('telnet'), null);
    assert.equal(dbHostAccent('local'), null);
    assert.equal(dbHostAccent('serial'), null);
    assert.equal(dbHostAccent(undefined), null);
  });
});
