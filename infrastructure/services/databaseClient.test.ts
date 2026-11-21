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
