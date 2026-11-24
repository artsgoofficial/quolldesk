import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Mock window.quolldesk before importing module (it reads lazily per call).
type Envelope = { ok: boolean; data?: unknown; error?: { code: string; message: string } };
const calls: { channel: string; args: unknown[] }[] = [];
let canned: Record<string, Envelope> = {};
(globalThis as Record<string, unknown>).window = {
  quolldesk: new Proxy({}, {
    get(_target, prop: string) {
      return async (...args: unknown[]) => {
        calls.push({ channel: prop, args });
        return canned[prop] ?? { ok: true, data: {} };
      };
    },
  }),
};

import {
  resolveDbConnectArgs, databaseClient, DbClientError,
} from './databaseClient';
import type { Host } from '../../domain/models/connection';

const baseHost = {
  hostname: 'db.internal', port: 3306, username: 'root', password: 'pw',
} as unknown as Host;

describe('resolveDbConnectArgs', () => {
  it('direct connect without tunnel', () => {
    const args = resolveDbConnectArgs({ host: baseHost, dialect: 'mysql' });
    // .ssh must be asserted before deepEqual: @types/node v25's deepEqual has
    // an `asserts actual is expected` signature, which would narrow args to
    // the expected literal type and hide the ssh property from the checker.
    assert.equal(args.ssh, undefined);
    assert.deepEqual(args, { hostname: 'db.internal', port: 3306, username: 'root', password: 'pw', config: {} });
  });
  it('adds ssh payload when tunnel host present', () => {
    const tunnel = { hostname: 'jump', port: 2222, username: 'u', password: 'p', hostChain: ['c1'] } as unknown as Host;
    const chain = [{ hostname: 'hop0', port: 22, username: 'h', password: 'hp' } as unknown as Host];
    const args = resolveDbConnectArgs({ host: baseHost, dialect: 'redis', tunnelHost: tunnel, tunnelChain: chain });
    assert.equal(args.ssh?.hostname, 'jump');
    assert.equal(args.ssh?.port, 2222);
    assert.equal(args.ssh?.jumpHosts?.[0].hostname, 'hop0');
    assert.equal(args.config.tunnelHostId, undefined);
  });
  it('carries dialect config', () => {
    const host = { ...baseHost, redisConfig: { redisDb: 3, cluster: true } } as unknown as Host;
    const args = resolveDbConnectArgs({ host, dialect: 'redis' });
    assert.deepEqual(args.config, { redisDb: 3, cluster: true });
  });
});

describe('resolveDbConnectArgs port defaults', () => {
  it('mysql portless host falls back to dialect default 3306', () => {
    const host = { hostname: 'db.internal', username: 'root', password: 'pw' } as unknown as Host;
    const args = resolveDbConnectArgs({ host, dialect: 'mysql' });
    assert.equal(args.port, 3306);
  });
});

describe('resolveDbConnectArgs sqlite', () => {
  it('sqlite: hostname is the file path, port omitted, filePath passes through', () => {
    const args = resolveDbConnectArgs({
      host: { hostname: '/tmp/a.db', sqlConfig: { filePath: '/tmp/a.db' } } as unknown as Host,
      dialect: 'sqlite',
    });
    assert.equal(args.port, undefined);
    assert.equal(args.config.filePath, '/tmp/a.db');
  });
});

describe('databaseClient registry-driven SQL engines', () => {
  it('mariadb.test invokes testMariadbConnection', async () => {
    canned = { testMariadbConnection: { ok: true, data: { latencyMs: 7 } } };
    const res = await databaseClient.mariadb.test({ hostname: 'db' } as never);
    assert.deepEqual(res, { latencyMs: 7 });
    assert.equal(calls.at(-1)?.channel, 'testMariadbConnection');
    canned = {};
  });
  it('sqlite.query invokes querySqlite with the unified args shape', async () => {
    canned = { querySqlite: { ok: true, data: { resultSets: [], executionTimeMs: 1, truncated: false } } };
    const args = { connectionId: 'c1', sql: 'select 1', values: [1], timeoutMs: 2000 };
    const res = await databaseClient.sqlite.query(args);
    assert.equal(res.executionTimeMs, 1);
    assert.equal(calls.at(-1)?.channel, 'querySqlite');
    assert.deepEqual(calls.at(-1)?.args[0], args);
    canned = {};
  });
  it('mssql.backup invokes backupMssql', async () => {
    canned = { backupMssql: { ok: true, data: { jobId: 'j1' } } };
    const args = { connectionId: 'c1', scope: 'database' as const, outFile: '/tmp/b.bak' };
    const res = await databaseClient.mssql.backup(args);
    assert.deepEqual(res, { jobId: 'j1' });
    assert.equal(calls.at(-1)?.channel, 'backupMssql');
    assert.deepEqual(calls.at(-1)?.args[0], args);
    canned = {};
  });
  it('regression: mysql.query still maps to queryMysql (timeoutMs passthrough)', async () => {
    canned = { queryMysql: { ok: true, data: { resultSets: [], executionTimeMs: 2, truncated: false } } };
    const args = { connectionId: 'c1', sql: 'select 1', timeoutMs: 500 };
    await databaseClient.mysql.query(args);
    assert.equal(calls.at(-1)?.channel, 'queryMysql');
    assert.deepEqual(calls.at(-1)?.args[0], args);
    canned = {};
  });
  it('regression: postgresql.query still maps to queryPg (values passthrough)', async () => {
    canned = { queryPg: { ok: true, data: { resultSets: [], executionTimeMs: 3, truncated: false } } };
    const args = { connectionId: 'c1', sql: 'select 1', values: ['x'] };
    await databaseClient.postgresql.query(args);
    assert.equal(calls.at(-1)?.channel, 'queryPg');
    assert.deepEqual(calls.at(-1)?.args[0], args);
    canned = {};
  });
});

describe('databaseClient unwraps envelopes', () => {
  it('throws DbClientError on ok:false', async () => {
    canned = { getMysqlSchemaTree: { ok: false, error: { code: 'NOT_CONNECTED', message: 'nope' } } };
    await assert.rejects(
      () => databaseClient.mysql.schemaTree('c1'),
      (err: unknown) => err instanceof DbClientError && err.code === 'NOT_CONNECTED',
    );
    canned = {};
  });
  it('returns data on ok:true', async () => {
    canned = { getMysqlSchemaTree: { ok: true, data: { databases: [] } } };
    const tree = await databaseClient.mysql.schemaTree('c1');
    assert.deepEqual(tree, { databases: [] });
    assert.equal(calls.at(-1)?.channel, 'getMysqlSchemaTree');
    canned = {};
  });
  it('throws BridgeUnavailableError-shaped DbClientError when quolldesk missing', async () => {
    const saved = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {};
    await assert.rejects(() => databaseClient.mysql.schemaTree('c1'), DbClientError);
    (globalThis as { window?: unknown }).window = saved;
  });
});
