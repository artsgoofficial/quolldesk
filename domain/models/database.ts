import type { HostProtocol } from './connection';
import type { TerminalSession } from './terminal';

export type DbProtocol = 'redis' | 'mysql' | 'postgresql';

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
}

export const DB_DEFAULT_PORTS: Record<DbProtocol, number> = {
  redis: 6379, mysql: 3306, postgresql: 5432,
};

const isDbProtocolValue = (p: unknown): p is DbProtocol =>
  p === 'redis' || p === 'mysql' || p === 'postgresql';

export const isDbProtocol = (p: HostProtocol | undefined): p is DbProtocol => isDbProtocolValue(p);

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

const isValidDbIndex = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 15;

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
  return out;
}

export function hostsForDbSection<T extends { protocol?: HostProtocol }>(
  hosts: T[], section: 'redis' | 'databases',
): T[] {
  return hosts.filter(h =>
    section === 'redis' ? h.protocol === 'redis'
      : h.protocol === 'mysql' || h.protocol === 'postgresql');
}

export function filterOutDbHosts<T extends { protocol?: HostProtocol }>(hosts: T[]): T[] {
  return hosts.filter(h => !isDbProtocolValue(h.protocol));
}

/** Hosts usable as SSH tunnel endpoints (plain ssh entries and protocol-less legacy hosts). */
export function sshTunnelCandidates<T extends { protocol?: HostProtocol }>(hosts: T[]): T[] {
  return hosts.filter(h => !h.protocol || h.protocol === 'ssh');
}
