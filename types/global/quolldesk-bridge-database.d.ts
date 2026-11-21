// Database client bridge surface (redis / mysql / postgresql GUI clients).
// Interface-merges into QuollDeskBridge declared in quolldesk-bridge-session.d.ts.

export type DbEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export interface DbSshTunnelOptions {
  hostname: string;
  port?: number;
  username?: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  jumpHosts?: DbSshTunnelOptions[];
}

export interface DbConnectOptions {
  hostname: string;
  /** Optional: SQLite connects to a file and has no port. */
  port?: number;
  username?: string;
  password?: string;
  config?: {
    database?: string;
    redisDb?: number;
    redisUsername?: string;
    tls?: boolean;
    tlsInsecure?: boolean;
    tunnelHostId?: string;
    cluster?: boolean;
    clusterNodes?: { hostname: string; port: number }[];
    /** SQLite only: path of the database file. */
    filePath?: string;
    /** SQLite only: open the database read-only. */
    readOnly?: boolean;
  };
  /** Present when the host resolves to an SSH tunnel (renderer-built). */
  ssh?: DbSshTunnelOptions;
}

export interface RedisScanResult { cursor: string | number; keys: { name: string; nodeId?: string }[] }
export interface RedisKeyMeta { type: string; ttlMs: number | null; sizeBytes: number | null }
export interface RedisKeyValuePage {
  items: { index: number | string; value: string | null; score?: number }[];
  cursor?: number | string;
  hasMore?: boolean;
  truncated?: boolean;
  note?: string;
}

export interface SqlSchemaTree { databases: { name: string; tables: string[]; views: string[] }[] }
export interface SqlColumnMeta { name: string; type: string; nullable: boolean; key?: string | null; defaultValue?: unknown }
export interface SqlIndexMeta { name: string; columns: string[]; unique?: boolean; /** Access method (mysql BTREE/HASH; pg btree/hash/gin/gist/spgist/brin). */ method?: string | null }
/** Primary key of a table: constraint name plus ordered columns ('PRI' flags land on SqlColumnMeta). */
export interface SqlPrimaryKeyMeta { name: string | null; columns: string[] }
/** Foreign key of a table (SqlTableData jump-through): local column → referenced table column. */
export interface SqlForeignKeyMeta { column: string; refTable: string; refSchema?: string; refColumn: string }
export interface SqlTableMeta {
  columns: SqlColumnMeta[];
  indexes: SqlIndexMeta[];
  primaryKey: SqlPrimaryKeyMeta | null;
  foreignKeys: SqlForeignKeyMeta[];
  ddl: string | null;
  rowCountEstimate: number;
}
export interface SqlTableRows { columns: { name: string }[]; rows: unknown[][]; truncated: boolean }
export interface SqlResultSet { columns: { name: string }[]; rows: unknown[][]; affectedRows?: number }
export interface SqlQueryResult { resultSets: SqlResultSet[]; executionTimeMs: number; truncated: boolean }

/** Grid filter chip (SqlTableData composer). `nul`/`nnul` carry no value. */
export interface DbGridFilter {
  column: string;
  op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'like' | 'nul' | 'nnul';
  value?: string | null;
}
export interface SqlTableRowsArgs {
  connectionId: string;
  table: string;
  schema?: string;
  orderBy?: string;
  orderDir?: 'asc' | 'desc';
  filters?: DbGridFilter[];
  offset?: number;
  limit?: number;
}

export interface DbPendingUpdate { pk: string; pkValue: string; column: string; value: string | null }
export interface DbPendingInsert { values: Record<string, string | null> }
export interface DbPendingDelete { pk: string; pkValue: string }
export interface DbTableChanges {
  updates?: DbPendingUpdate[];
  inserts?: DbPendingInsert[];
  deletes?: DbPendingDelete[];
}
export interface DbAppliedChanges { updates: number; inserts: number; deletes: number }

/** SQL backup/restore (Wave 6). */
export interface DbBackupOptions {
  connectionId: string;
  scope: 'database' | 'table';
  /** Required for scope 'table'. */
  table?: string;
  /** pg table scope only (default 'public'). */
  schema?: string;
  includeData?: boolean;
  outFile: string;
}
export interface DbRestoreOptions { connectionId: string; inFile: string }
/** Push payload on quolldesk:db:jobProgress (single channel, both dialects). */
export interface DbJobProgress {
  jobId: string;
  dialect: 'mysql' | 'postgresql' | 'mariadb' | 'mssql' | 'sqlite';
  phase: 'tables' | 'rows' | 'views' | 'restore' | 'done' | 'error';
  /** Table being dumped / restored (pg: 'schema.table'). */
  table?: string;
  /** Rows streamed so far for `table`. */
  rowsDone?: number;
  /** Dump-side table counters (phase 'tables'/'done'). */
  tablesDone?: number;
  tablesTotal?: number;
  /** Restore-side statement counters (phase 'restore'). */
  done?: number;
  total?: number;
  /** 1-based index of the failed statement (phase 'error'). */
  index?: number;
  message?: string;
  error?: string;
}
/** Push payload on quolldesk:db:connectionClosed (main process closed a connection the renderer still holds). */
export interface DbConnectionClosed {
  connectionId: string;
  dialect?: 'redis' | 'mysql' | 'postgresql' | 'mariadb' | 'mssql' | 'sqlite';
  /** 'idle-timeout' (registry reap) or 'driver-error' (server death); never 'user'/'renderer-gone'. */
  reason?: string;
}

declare global {
  interface QuollDeskBridge {
    connectRedis?(options: DbConnectOptions): Promise<DbEnvelope<{ connectionId: string }>>;
    disconnectRedis?(connectionId: string): Promise<DbEnvelope<Record<string, never>>>;
    testRedisConnection?(options: DbConnectOptions): Promise<DbEnvelope<{ latencyMs: number; pong?: string; serverVersion?: string }>>;
    scanRedisKeys?(args: { connectionId: string; match?: string; cursor?: string | number; count?: number; nodeId?: string }): Promise<DbEnvelope<RedisScanResult>>;
    getRedisKeyMeta?(args: { connectionId: string; key: string; nodeId?: string }): Promise<DbEnvelope<RedisKeyMeta>>;
    getRedisKeyValue?(args: { connectionId: string; key: string; type: string; cursor?: number | string; count?: number; nodeId?: string }): Promise<DbEnvelope<RedisKeyValuePage>>;
    getRedisServerInfo?(args: { connectionId: string; nodeId?: string }): Promise<DbEnvelope<{ summary: Record<string, string>; nodes?: { nodeId: string; host: string; port: number; role: string }[] }>>;
    selectRedisDb?(args: { connectionId: string; db: number }): Promise<DbEnvelope<{ db: number }>>;
    getRedisKeyTypes?(args: { connectionId: string; keys: string[]; nodeId?: string }): Promise<DbEnvelope<{ types: Record<string, string> }>>;
    subscribeRedis?(args: { connectionId: string; channel: string; pattern?: boolean }): Promise<DbEnvelope<{ channel: string; pattern: boolean }>>;
    unsubscribeRedis?(args: { connectionId: string; channel: string; pattern?: boolean }): Promise<DbEnvelope<{ channel: string; pattern: boolean }>>;
    runRedisCommand?(args: { connectionId: string; command: string }): Promise<DbEnvelope<{ command: string; reply: unknown }>>;
    createRedisKey?(args: { connectionId: string; key: string; value?: string; nodeId?: string }): Promise<DbEnvelope<{ key: string }>>;
    deleteRedisKey?(args: { connectionId: string; key: string; nodeId?: string }): Promise<DbEnvelope<{ key: string }>>;
    renameRedisKey?(args: { connectionId: string; key: string; newKey: string; nodeId?: string }): Promise<DbEnvelope<{ key: string }>>;
    expireRedisKey?(args: { connectionId: string; key: string; ttlSeconds: number | null; nodeId?: string }): Promise<DbEnvelope<{ ttlSeconds: number | null }>>;
    setRedisStringValue?(args: { connectionId: string; key: string; value: string; nodeId?: string }): Promise<DbEnvelope<{ key: string }>>;
    addRedisHashField?(args: { connectionId: string; key: string; field: string; value: string; nodeId?: string }): Promise<DbEnvelope<Record<string, never>>>;
    removeRedisHashField?(args: { connectionId: string; key: string; field: string; nodeId?: string }): Promise<DbEnvelope<Record<string, never>>>;
    pushRedisList?(args: { connectionId: string; key: string; position: 'left' | 'right'; value: string; nodeId?: string }): Promise<DbEnvelope<Record<string, never>>>;
    removeRedisListValue?(args: { connectionId: string; key: string; value: string; nodeId?: string }): Promise<DbEnvelope<Record<string, never>>>;
    addRedisSetMember?(args: { connectionId: string; key: string; member: string; nodeId?: string }): Promise<DbEnvelope<Record<string, never>>>;
    removeRedisSetMember?(args: { connectionId: string; key: string; member: string; nodeId?: string }): Promise<DbEnvelope<Record<string, never>>>;
    addRedisZsetMember?(args: { connectionId: string; key: string; member: string; score: number; nodeId?: string }): Promise<DbEnvelope<Record<string, never>>>;
    removeRedisZsetMember?(args: { connectionId: string; key: string; member: string; nodeId?: string }): Promise<DbEnvelope<Record<string, never>>>;
    onRedisPubsubMessage?(cb: (payload: { connectionId: string; channel: string; pattern?: string | null; message: string; receivedAt: number }) => void): () => void;

    connectMysql?(options: DbConnectOptions): Promise<DbEnvelope<{ connectionId: string }>>;
    disconnectMysql?(connectionId: string): Promise<DbEnvelope<Record<string, never>>>;
    testMysqlConnection?(options: DbConnectOptions): Promise<DbEnvelope<{ latencyMs: number; serverVersion?: string }>>;
    getMysqlSchemaTree?(args: { connectionId: string }): Promise<DbEnvelope<SqlSchemaTree>>;
    getMysqlTableMeta?(args: { connectionId: string; table: string; schema?: string }): Promise<DbEnvelope<SqlTableMeta>>;
    getMysqlTableRows?(args: SqlTableRowsArgs): Promise<DbEnvelope<SqlTableRows>>;
    queryMysql?(args: { connectionId: string; sql: string; timeoutMs?: number }): Promise<DbEnvelope<SqlQueryResult>>;
    applyMysqlTableChanges?(args: { connectionId: string; table: string; schema?: string; changes: DbTableChanges }): Promise<DbEnvelope<{ applied: DbAppliedChanges }>>;
    pickMysqlBackupPath?(args: { defaultName?: string }): Promise<DbEnvelope<{ path: string | null }>>;
    pickMysqlRestoreFile?(args?: Record<string, never>): Promise<DbEnvelope<{ path: string | null }>>;
    backupMysql?(args: DbBackupOptions): Promise<DbEnvelope<{ jobId: string }>>;
    restoreMysql?(args: DbRestoreOptions): Promise<DbEnvelope<{ jobId: string }>>;

    connectPg?(options: DbConnectOptions): Promise<DbEnvelope<{ connectionId: string }>>;
    disconnectPg?(connectionId: string): Promise<DbEnvelope<Record<string, never>>>;
    testPgConnection?(options: DbConnectOptions): Promise<DbEnvelope<{ latencyMs: number; serverVersion?: string }>>;
    getPgSchemaTree?(args: { connectionId: string }): Promise<DbEnvelope<SqlSchemaTree>>;
    getPgTableMeta?(args: { connectionId: string; table: string; schema?: string }): Promise<DbEnvelope<SqlTableMeta>>;
    getPgTableRows?(args: SqlTableRowsArgs): Promise<DbEnvelope<SqlTableRows>>;
    queryPg?(args: { connectionId: string; sql: string; values?: unknown[] }): Promise<DbEnvelope<SqlQueryResult>>;
    applyPgTableChanges?(args: { connectionId: string; table: string; schema?: string; changes: DbTableChanges }): Promise<DbEnvelope<{ applied: DbAppliedChanges }>>;
    pickPgBackupPath?(args: { defaultName?: string }): Promise<DbEnvelope<{ path: string | null }>>;
    pickPgRestoreFile?(args?: Record<string, never>): Promise<DbEnvelope<{ path: string | null }>>;
    backupPg?(args: DbBackupOptions): Promise<DbEnvelope<{ jobId: string }>>;
    restorePg?(args: DbRestoreOptions): Promise<DbEnvelope<{ jobId: string }>>;

    connectMariadb?(options: DbConnectOptions): Promise<DbEnvelope<{ connectionId: string }>>;
    disconnectMariadb?(connectionId: string): Promise<DbEnvelope<Record<string, never>>>;
    testMariadbConnection?(options: DbConnectOptions): Promise<DbEnvelope<{ latencyMs: number; serverVersion?: string }>>;
    getMariadbSchemaTree?(args: { connectionId: string }): Promise<DbEnvelope<SqlSchemaTree>>;
    getMariadbTableMeta?(args: { connectionId: string; table: string; schema?: string }): Promise<DbEnvelope<SqlTableMeta>>;
    getMariadbTableRows?(args: SqlTableRowsArgs): Promise<DbEnvelope<SqlTableRows>>;
    queryMariadb?(args: { connectionId: string; sql: string; values?: unknown[]; timeoutMs?: number }): Promise<DbEnvelope<SqlQueryResult>>;
    applyMariadbTableChanges?(args: { connectionId: string; table: string; schema?: string; changes: DbTableChanges }): Promise<DbEnvelope<{ applied: DbAppliedChanges }>>;
    pickMariadbBackupPath?(args: { defaultName?: string }): Promise<DbEnvelope<{ path: string | null }>>;
    pickMariadbRestoreFile?(args?: Record<string, never>): Promise<DbEnvelope<{ path: string | null }>>;
    backupMariadb?(args: DbBackupOptions): Promise<DbEnvelope<{ jobId: string }>>;
    restoreMariadb?(args: DbRestoreOptions): Promise<DbEnvelope<{ jobId: string }>>;

    connectMssql?(options: DbConnectOptions): Promise<DbEnvelope<{ connectionId: string }>>;
    disconnectMssql?(connectionId: string): Promise<DbEnvelope<Record<string, never>>>;
    testMssqlConnection?(options: DbConnectOptions): Promise<DbEnvelope<{ latencyMs: number; serverVersion?: string }>>;
    getMssqlSchemaTree?(args: { connectionId: string }): Promise<DbEnvelope<SqlSchemaTree>>;
    getMssqlTableMeta?(args: { connectionId: string; table: string; schema?: string }): Promise<DbEnvelope<SqlTableMeta>>;
    getMssqlTableRows?(args: SqlTableRowsArgs): Promise<DbEnvelope<SqlTableRows>>;
    queryMssql?(args: { connectionId: string; sql: string; values?: unknown[]; timeoutMs?: number }): Promise<DbEnvelope<SqlQueryResult>>;
    applyMssqlTableChanges?(args: { connectionId: string; table: string; schema?: string; changes: DbTableChanges }): Promise<DbEnvelope<{ applied: DbAppliedChanges }>>;
    pickMssqlBackupPath?(args: { defaultName?: string }): Promise<DbEnvelope<{ path: string | null }>>;
    pickMssqlRestoreFile?(args?: Record<string, never>): Promise<DbEnvelope<{ path: string | null }>>;
    backupMssql?(args: DbBackupOptions): Promise<DbEnvelope<{ jobId: string }>>;
    restoreMssql?(args: DbRestoreOptions): Promise<DbEnvelope<{ jobId: string }>>;

    connectSqlite?(options: DbConnectOptions): Promise<DbEnvelope<{ connectionId: string }>>;
    disconnectSqlite?(connectionId: string): Promise<DbEnvelope<Record<string, never>>>;
    testSqliteConnection?(options: DbConnectOptions): Promise<DbEnvelope<{ latencyMs: number; serverVersion?: string }>>;
    getSqliteSchemaTree?(args: { connectionId: string }): Promise<DbEnvelope<SqlSchemaTree>>;
    getSqliteTableMeta?(args: { connectionId: string; table: string; schema?: string }): Promise<DbEnvelope<SqlTableMeta>>;
    getSqliteTableRows?(args: SqlTableRowsArgs): Promise<DbEnvelope<SqlTableRows>>;
    querySqlite?(args: { connectionId: string; sql: string; values?: unknown[]; timeoutMs?: number }): Promise<DbEnvelope<SqlQueryResult>>;
    applySqliteTableChanges?(args: { connectionId: string; table: string; schema?: string; changes: DbTableChanges }): Promise<DbEnvelope<{ applied: DbAppliedChanges }>>;
    pickSqliteBackupPath?(args: { defaultName?: string }): Promise<DbEnvelope<{ path: string | null }>>;
    pickSqliteRestoreFile?(args?: Record<string, never>): Promise<DbEnvelope<{ path: string | null }>>;
    backupSqlite?(args: DbBackupOptions): Promise<DbEnvelope<{ jobId: string }>>;
    restoreSqlite?(args: DbRestoreOptions): Promise<DbEnvelope<{ jobId: string }>>;
    /** SQLite only: file picker for open/save of a database file. */
    pickSqliteDatabaseFile?(args?: { mode?: 'open' | 'save' }): Promise<DbEnvelope<{ path: string | null }>>;

    /** Shared job-progress pushes for SQL backup/restore (both dialects). */
    onDbJobProgress?(cb: (payload: DbJobProgress) => void): () => void;
    /** Pushed when the main process closes a connection the renderer still holds (idle reap / driver death). */
    onDbConnectionClosed?(cb: (payload: DbConnectionClosed) => void): () => void;
  }
}

export {};
