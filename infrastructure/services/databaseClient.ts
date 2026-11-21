// Typed renderer-side client for the QuollDesk database bridges
// (redis / mysql / postgresql). Every call goes through window.quolldesk
// (via quolldeskBridge) and unwraps the DbEnvelope: `ok:false` becomes a
// thrown DbClientError carrying the bridge error code.

import type {
  DbBackupOptions,
  DbConnectionClosed,
  DbConnectOptions,
  DbEnvelope,
  DbGridFilter,
  DbJobProgress,
  DbTableChanges,
  DbRestoreOptions,
  SqlQueryResult,
  SqlSchemaTree,
  SqlTableMeta,
  SqlTableRows,
} from '../../types/global/quolldesk-bridge-database';
// RedisConnectionConfig / SqlConnectionConfig are defined in
// domain/models/database (connection.ts imports them but does not re-export).
import type {
  RedisConnectionConfig,
  SqlConnectionConfig,
} from '../../domain/models/database';
import { DB_DEFAULT_PORTS } from '../../domain/models/database';
// HostChainConfig is Host's real hostChain shape ({ hostIds: string[] });
// HostLike must stay structurally assignable FROM Host.
import type { HostChainConfig } from '../../domain/models/connection';
import { quolldeskBridge } from './quolldeskBridge';

export type DbDialect = 'redis' | 'mysql' | 'postgresql';

export class DbClientError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DbClientError';
    this.code = code;
  }
}

/** User-facing message for anything this client (or a caller) threw. */
export function dbErrorMessage(err: unknown): string {
  return err instanceof DbClientError ? err.message : String(err);
}

interface HostLike {
  hostname: string;
  port?: number;
  username?: string;
  password?: string;
  identityFile?: string;
  privateKeyPassphrase?: string;
  hostChain?: HostChainConfig;
}

type DbBridge = NonNullable<typeof window.quolldesk>;

// Async + `?.ok !== true` (not a truthiness/null-guard compound): the repo
// tsconfig is non-strict, and without strictNullChecks a falsy guard keeps the
// full union, so `envelope.error` would not narrow. The optional-chaining
// discriminant compare narrows in both strict and non-strict modes while
// staying tolerant of a malformed (undefined) envelope at runtime.
async function unwrap<T>(promise: Promise<DbEnvelope<T>>): Promise<T> {
  const envelope: DbEnvelope<T> | undefined = await promise;
  if (envelope?.ok !== true) {
    throw new DbClientError(
      envelope?.error?.code ?? 'INTERNAL',
      envelope?.error?.message ?? 'Unknown database error',
    );
  }
  return envelope.data;
}

function bridge(): DbBridge {
  const b = quolldeskBridge.get();
  if (!b) throw new DbClientError('BRIDGE_UNAVAILABLE', 'QuollDesk bridge unavailable');
  return b;
}

// Explicit method lookup: a missing bridge method surfaces as a typed
// DbClientError instead of relying on `as never` double assertions.
// `method` is `keyof DbBridge`, so every call site is checked against the
// Task 11 bridge declaration at compile time. Async so a missing bridge
// rejects the returned promise (callers see DbClientError via await/catch,
// never a synchronous throw).
async function call<T>(method: keyof DbBridge, ...args: unknown[]): Promise<T> {
  const fn = bridge()[method] as ((...a: unknown[]) => Promise<DbEnvelope<T>>) | undefined;
  if (!fn) throw new DbClientError('BRIDGE_UNAVAILABLE', `${method} unavailable`);
  return unwrap(fn(...args));
}

export function resolveDbConnectArgs(params: {
  host: HostLike & { redisConfig?: RedisConnectionConfig; sqlConfig?: SqlConnectionConfig };
  dialect: DbDialect;
  tunnelHost?: HostLike;
  tunnelChain?: HostLike[];
}): DbConnectOptions {
  const { host, dialect, tunnelHost, tunnelChain } = params;
  const config: NonNullable<DbConnectOptions['config']> = {};
  if (dialect === 'redis') {
    if (host.redisConfig) Object.assign(config, host.redisConfig);
  } else if (host.sqlConfig) {
    Object.assign(config, host.sqlConfig);
  }
  // Tunnel resolution happens renderer-side; never forward a stale id.
  delete (config as { tunnelHostId?: string }).tunnelHostId;

  const args: DbConnectOptions = {
    hostname: host.hostname,
    // A portless host must dial the dialect default, not port 0 — port 0 is
    // invalid for a remote dial and fails with a confusing error.
    port: host.port ?? DB_DEFAULT_PORTS[dialect],
    username: host.username,
    password: host.password,
    config,
  };

  if (tunnelHost) {
    const serialize = (h: HostLike) => ({
      hostname: h.hostname,
      port: h.port ?? 22,
      username: h.username,
      password: h.password,
      privateKeyPath: h.identityFile,
      passphrase: h.privateKeyPassphrase,
    });
    // v1: only an explicitly passed tunnelChain expands into jumpHosts.
    const jumps = (tunnelChain ?? []).map(serialize);
    args.ssh = { ...serialize(tunnelHost), jumpHosts: jumps.length > 0 ? jumps : undefined };
  }
  return args;
}

function makeRedisMethods() {
  return {
    connect: (opts: DbConnectOptions) => call<{ connectionId: string }>('connectRedis', opts),
    disconnect: (connectionId: string) => call<Record<string, never>>('disconnectRedis', connectionId),
    test: (opts: DbConnectOptions) =>
      call<{ latencyMs: number; serverVersion?: string }>('testRedisConnection', opts),
    scan: (args: { connectionId: string; match?: string; cursor?: string | number; count?: number; nodeId?: string }) =>
      call<{ cursor: string | number; keys: { name: string; nodeId?: string }[] }>('scanRedisKeys', args),
    keyMeta: (args: { connectionId: string; key: string; nodeId?: string }) =>
      call<{ type: string; ttlMs: number | null; sizeBytes: number | null }>('getRedisKeyMeta', args),
    keyValue: (args: { connectionId: string; key: string; type: string; cursor?: number | string; count?: number; nodeId?: string }) =>
      call<{ items: { index: number | string; value: string | null; score?: number }[]; cursor?: number | string; hasMore?: boolean; truncated?: boolean }>('getRedisKeyValue', args),
    serverInfo: (args: { connectionId: string; nodeId?: string }) =>
      call<{ summary: Record<string, string>; nodes?: { nodeId: string; host: string; port: number; role: string }[] }>('getRedisServerInfo', args),
    selectDb: (args: { connectionId: string; db: number }) =>
      call<{ db: number }>('selectRedisDb', args),
    keyTypes: (args: { connectionId: string; keys: string[]; nodeId?: string }) =>
      call<{ types: Record<string, string> }>('getRedisKeyTypes', args),
    subscribe: (args: { connectionId: string; channel: string; pattern?: boolean }) =>
      call<{ channel: string; pattern: boolean }>('subscribeRedis', args),
    unsubscribe: (args: { connectionId: string; channel: string; pattern?: boolean }) =>
      call<{ channel: string; pattern: boolean }>('unsubscribeRedis', args),
    runCommand: (args: { connectionId: string; command: string }) =>
      call<{ command: string; reply: unknown }>('runRedisCommand', args),
    // Key management (Wave 3): one method per quolldesk:redis:* write channel.
    createKey: (args: { connectionId: string; key: string; value?: string; nodeId?: string }) =>
      call<{ key: string }>('createRedisKey', args),
    deleteKey: (args: { connectionId: string; key: string; nodeId?: string }) =>
      call<{ key: string }>('deleteRedisKey', args),
    renameKey: (args: { connectionId: string; key: string; newKey: string; nodeId?: string }) =>
      call<{ key: string }>('renameRedisKey', args),
    expireKey: (args: { connectionId: string; key: string; ttlSeconds: number | null; nodeId?: string }) =>
      call<{ ttlSeconds: number | null }>('expireRedisKey', args),
    setStringValue: (args: { connectionId: string; key: string; value: string; nodeId?: string }) =>
      call<{ key: string }>('setRedisStringValue', args),
    hashSetField: (args: { connectionId: string; key: string; field: string; value: string; nodeId?: string }) =>
      call<Record<string, never>>('addRedisHashField', args),
    hashDeleteField: (args: { connectionId: string; key: string; field: string; nodeId?: string }) =>
      call<Record<string, never>>('removeRedisHashField', args),
    listPush: (args: { connectionId: string; key: string; position: 'left' | 'right'; value: string; nodeId?: string }) =>
      call<Record<string, never>>('pushRedisList', args),
    listRemoveValue: (args: { connectionId: string; key: string; value: string; nodeId?: string }) =>
      call<Record<string, never>>('removeRedisListValue', args),
    setAddMember: (args: { connectionId: string; key: string; member: string; nodeId?: string }) =>
      call<Record<string, never>>('addRedisSetMember', args),
    setRemoveMember: (args: { connectionId: string; key: string; member: string; nodeId?: string }) =>
      call<Record<string, never>>('removeRedisSetMember', args),
    zsetAddMember: (args: { connectionId: string; key: string; member: string; score: number; nodeId?: string }) =>
      call<Record<string, never>>('addRedisZsetMember', args),
    zsetRemoveMember: (args: { connectionId: string; key: string; member: string; nodeId?: string }) =>
      call<Record<string, never>>('removeRedisZsetMember', args),
    onPubsubMessage: (cb: (payload: { connectionId: string; channel: string; pattern?: string | null; message: string; receivedAt: number }) => void) => {
      const fn = bridge().onRedisPubsubMessage;
      if (typeof fn !== 'function') throw new DbClientError('BRIDGE_UNAVAILABLE', 'onRedisPubsubMessage unavailable');
      return fn(cb);
    },
  };
}

// Bridge method names per dialect (must match the Task 11 declaration):
// connectMysql / connectPg, disconnectMysql / disconnectPg,
// testMysqlConnection / testPgConnection, getMysqlSchemaTree / getPgSchemaTree,
// getMysqlTableMeta / getPgTableMeta, getMysqlTableRows / getPgTableRows,
// queryMysql / queryPg. Because `method` is keyof DbBridge, a wrong name is a
// compile error, not a runtime surprise.
function makeSqlMethods(dialect: 'mysql' | 'postgresql') {
  const cap: 'Mysql' | 'Pg' = dialect === 'mysql' ? 'Mysql' : 'Pg';
  const isMysql = dialect === 'mysql';
  return {
    connect: (opts: DbConnectOptions) => call<{ connectionId: string }>(`connect${cap}`, opts),
    disconnect: (connectionId: string) => call<Record<string, never>>(`disconnect${cap}`, connectionId),
    test: (opts: DbConnectOptions) =>
      call<{ latencyMs: number; serverVersion?: string }>(`test${cap}Connection`, opts),
    schemaTree: (connectionId: string) =>
      call<SqlSchemaTree>(`get${cap}SchemaTree`, { connectionId }),
    tableMeta: (args: { connectionId: string; table: string; schema?: string }) =>
      call<SqlTableMeta>(`get${cap}TableMeta`, args),
    tableRows: (args: { connectionId: string; table: string; schema?: string; orderBy?: string; orderDir?: 'asc' | 'desc'; filters?: DbGridFilter[]; offset?: number; limit?: number }) =>
      call<SqlTableRows>(`get${cap}TableRows`, args),
    query: isMysql
      ? (args: { connectionId: string; sql: string; timeoutMs?: number }) =>
          call<SqlQueryResult>('queryMysql', args)
      : (args: { connectionId: string; sql: string; values?: unknown[] }) =>
          call<SqlQueryResult>('queryPg', args),
    applyTableChanges: (args: { connectionId: string; table: string; schema?: string; changes: DbTableChanges }) =>
      call<{ applied: { updates: number; inserts: number; deletes: number } }>(`apply${cap}TableChanges`, args),
    // SQL backup/restore (Wave 6). backup/restore are async jobs: the invoke
    // resolves with a jobId, progress arrives via onJobProgress pushes.
    pickBackupPath: (defaultName?: string) =>
      call<{ path: string | null }>(`pick${cap}BackupPath`, { defaultName }),
    pickRestoreFile: () =>
      call<{ path: string | null }>(`pick${cap}RestoreFile`, {}),
    backup: (args: DbBackupOptions) =>
      call<{ jobId: string }>(`backup${cap}`, args),
    restore: (args: DbRestoreOptions) =>
      call<{ jobId: string }>(`restore${cap}`, args),
    onJobProgress: (cb: (payload: DbJobProgress) => void) => {
      const fn = bridge().onDbJobProgress;
      if (typeof fn !== 'function') throw new DbClientError('BRIDGE_UNAVAILABLE', 'onDbJobProgress unavailable');
      return fn(cb);
    },
  };
}

export const databaseClient = {
  redis: makeRedisMethods(),
  mysql: makeSqlMethods('mysql'),
  postgresql: makeSqlMethods('postgresql'),
} as const;

/**
 * Main-process-initiated connection closes (idle reap, driver death), pushed
 * on the shared quolldesk:db:connectionClosed channel. Dialect-agnostic — one
 * subscription serves every open workbench tab, which match on connectionId.
 * Throws DbClientError when the bridge is unavailable (non-electron tests);
 * callers that run in those environments subscribe best-effort.
 */
export function onDbConnectionClosed(cb: (payload: DbConnectionClosed) => void): () => void {
  const fn = bridge().onDbConnectionClosed;
  if (typeof fn !== 'function') throw new DbClientError('BRIDGE_UNAVAILABLE', 'onDbConnectionClosed unavailable');
  return fn(cb);
}
