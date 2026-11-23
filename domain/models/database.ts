import type { HostProtocol } from './connection';
import { isSqlEngineId, SQL_ENGINE_BY_ID, SQL_ENGINES } from './dbEngines';
import type { TerminalSession } from './terminal';

export type DbProtocol = 'redis' | 'mysql' | 'postgresql' | 'mariadb' | 'mssql' | 'sqlite';

/** Workbench connection lifecycle (useDatabaseWorkbenchState). */
export type DbWorkbenchStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'disconnected';

export interface DbConnectionBase {
  tls?: boolean;
  tlsInsecure?: boolean;
  tunnelHostId?: string;
}

export interface RedisClusterNode { hostname: string; port: number }

export interface RedisConnectionConfig extends DbConnectionBase {
  redisDb?: number;
  redisUsername?: string;
  cluster?: boolean;
  clusterNodes?: RedisClusterNode[];
}

export interface SqlConnectionConfig extends DbConnectionBase {
  database?: string;
  /** SQLite 数据库文件路径(sqlite 引擎专用)。 */
  filePath?: string;
  /** SQLite 专用:只读方式打开数据库文件(sqliteBridge connect 读取)。 */
  readOnly?: boolean;
}

/** SQL engine ports derive from the dbEngines registry (redis keeps its own). */
export const DB_DEFAULT_PORTS: Record<DbProtocol, number | null> = {
  redis: 6379,
  ...Object.fromEntries(SQL_ENGINES.map((e) => [e.id, e.defaultPort])),
} as Record<DbProtocol, number | null>;

const isDbProtocolValue = (p: unknown): p is DbProtocol => p === 'redis' || isSqlEngineId(p);

export const isDbProtocol = (p: HostProtocol | undefined): p is DbProtocol => isDbProtocolValue(p);

/** Redis flat-list accent (brand red) — shared by db lists and host tree avatars. */
export const REDIS_HOST_ACCENT = '#D44B4B';

/**
 * Brand accent for a db host's avatar (DistroAvatar): redis keeps its brand
 * red, sql engines reuse their registry accent (same language as the db
 * section lists). Non-db protocols return null so hosts keep their own
 * distro/server avatar.
 */
export const dbHostAccent = (p: HostProtocol | undefined): string | null => {
  if (p === 'redis') return REDIS_HOST_ACCENT;
  return isSqlEngineId(p) ? SQL_ENGINE_BY_ID[p].accent : null;
};

/**
 * Display name for a db host's database (tree/schema label, dump file names).
 * File-backed engines (sqlite) keep the file's bare name — the file path
 * lives in hostname; hostPort engines use the configured database, falling
 * back to the hostname. One derivation so every consumer agrees on Windows
 * path separators too.
 */
export const dbHostDatabaseName = (host: {
  protocol?: HostProtocol;
  hostname?: string;
  sqlConfig?: SqlConnectionConfig;
}): string => {
  if (isSqlEngineId(host.protocol) && SQL_ENGINE_BY_ID[host.protocol].addressMode === 'file') {
    return (host.hostname ?? '').replace(/\\/g, '/').split('/').pop() || '';
  }
  return host.sqlConfig?.database || host.hostname || '';
};

/** Minimal host shape for building a shareable connection string. */
export interface DbConnectionStringHost {
  protocol?: HostProtocol;
  hostname?: string;
  port?: number;
  username?: string;
  password?: string;
  redisConfig?: RedisConnectionConfig;
  sqlConfig?: SqlConnectionConfig;
}

const encodeUserInfo = (raw: string): string => encodeURIComponent(raw);
const formatHost = (hostname: string): string =>
  hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;

/**
 * Builds a shareable connection URL for a db host (vault right-click
 * 「复制连接字符串」). Returns null for non-db protocols and sqlite hosts
 * without a file path. Semantics mirror the real dial config: redis takes
 * its ACL username from redisConfig (redisBridge), sql engines from
 * host.username. Password is included only when stored — a missing password
 * still yields a usable password-less URL.
 */
export const buildDbConnectionString = (host: DbConnectionStringHost): string | null => {
  if (!isDbProtocol(host.protocol)) return null;
  const protocol = host.protocol;
  if (protocol === 'sqlite') {
    const filePath = host.sqlConfig?.filePath;
    return filePath ? `sqlite://${filePath.startsWith('/') ? filePath : `/${filePath}`}` : null;
  }
  const username = protocol === 'redis'
    ? host.redisConfig?.redisUsername || host.username || ''
    : host.username || '';
  const password = host.password || '';
  // `user:pass@` / `user@` / `:pass@` (redis default-user password) / none
  const userinfo = password
    ? `${encodeUserInfo(username)}:${encodeUserInfo(password)}@`
    : username
      ? `${encodeUserInfo(username)}@`
      : '';
  const port = isValidPort(host.port) ? host.port : DB_DEFAULT_PORTS[protocol];
  const authority = `${formatHost(host.hostname || 'localhost')}:${port}`;
  if (protocol === 'redis') {
    const scheme = host.redisConfig?.tls ? 'rediss' : 'redis';
    const db = isValidRedisDbIndex(host.redisConfig?.redisDb) && host.redisConfig?.redisDb !== 0
      ? `/${host.redisConfig.redisDb}`
      : '';
    return `${scheme}://${userinfo}${authority}${db}`;
  }
  const database = host.sqlConfig?.database ? `/${encodeUserInfo(host.sqlConfig.database)}` : '';
  return `${protocol}://${userinfo}${authority}${database}`;
};

/**
 * Workbench status → tab status dot. DB sessions never run TerminalPane (the
 * usual status producer), so the workbench reports through onStatusChange
 * instead. 'idle' maps to null: fresh tabs are created 'connecting' and
 * autoConnect immediately, restored tabs keep 'disconnected' until the user
 * reconnects — reporting idle would flash the dot wrong in both cases.
 */
export const resolveDbSessionTabStatus = (
  status: DbWorkbenchStatus,
): TerminalSession['status'] | null => {
  switch (status) {
    case 'connecting': return 'connecting';
    case 'connected': return 'connected';
    case 'error':
    case 'disconnected': return 'disconnected';
    case 'idle': return null;
  }
};

export const isValidPort = (port: unknown): port is number =>
  typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;

/**
 * UI guardrail for the Redis SELECT index. Redis's `databases` is server
 * config — 16 is only the default and servers routinely expose more (SELECT
 * 0..databases-1) — so the form/sanitizer range must not be the default.
 * 65535 keeps the field sane while accepting every realistic config; the
 * driver's own SELECT error is the source of truth beyond that.
 */
export const REDIS_DB_INDEX_MAX = 65535;

export const isValidRedisDbIndex = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= REDIS_DB_INDEX_MAX;

const isValidDbIndex = isValidRedisDbIndex;

const sanitizeBase = (raw: Record<string, unknown>): DbConnectionBase => {
  const out: DbConnectionBase = {};
  if (typeof raw.tls === 'boolean') out.tls = raw.tls;
  if (typeof raw.tlsInsecure === 'boolean') out.tlsInsecure = raw.tlsInsecure;
  if (typeof raw.tunnelHostId === 'string' && raw.tunnelHostId) out.tunnelHostId = raw.tunnelHostId;
  return out;
};

export function normalizeRedisConfig(raw: unknown): RedisConnectionConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  const out: RedisConnectionConfig = { ...sanitizeBase(rec) };
  if (isValidDbIndex(rec.redisDb)) out.redisDb = rec.redisDb;
  if (typeof rec.redisUsername === 'string') out.redisUsername = rec.redisUsername.trim() || undefined;
  if (rec.cluster === true) {
    out.cluster = true;
    const seen = new Set<string>();
    const nodes: RedisClusterNode[] = [];
    if (Array.isArray(rec.clusterNodes)) {
      for (const node of rec.clusterNodes) {
        if (!node || typeof node !== 'object') continue;
        const n = node as Record<string, unknown>;
        const hostname = typeof n.hostname === 'string' ? n.hostname.trim() : '';
        if (!hostname || !isValidPort(n.port)) continue;
        const key = `${hostname}:${n.port}`;
        if (seen.has(key)) continue;
        seen.add(key);
        nodes.push({ hostname, port: n.port });
      }
    }
    if (nodes.length > 0) out.clusterNodes = nodes;
  }
  return out;
}

export function normalizeSqlConfig(raw: unknown): SqlConnectionConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  const out: SqlConnectionConfig = { ...sanitizeBase(rec) };
  if (typeof rec.database === 'string' && rec.database.trim()) out.database = rec.database.trim();
  if (typeof rec.filePath === 'string' && rec.filePath.trim()) out.filePath = rec.filePath.trim();
  // SQLite read-only open (DbConnectOptions.config.readOnly). Persisted only
  // for boolean inputs so hostPort engines serialize exactly as before.
  if (typeof rec.readOnly === 'boolean') out.readOnly = rec.readOnly;
  return out;
}

export function hostsForDbSection<T extends { protocol?: HostProtocol }>(
  hosts: T[], section: 'redis' | 'databases',
): T[] {
  return hosts.filter(h =>
    section === 'redis' ? h.protocol === 'redis' : isSqlEngineId(h.protocol));
}

export function filterOutDbHosts<T extends { protocol?: HostProtocol }>(hosts: T[]): T[] {
  return hosts.filter(h => !isDbProtocolValue(h.protocol));
}

/** Hosts usable as SSH tunnel endpoints (plain ssh entries and protocol-less legacy hosts). */
export function sshTunnelCandidates<T extends { protocol?: HostProtocol }>(hosts: T[]): T[] {
  return hosts.filter(h => !h.protocol || h.protocol === 'ssh');
}
