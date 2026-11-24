export type SqlEngineId = 'mysql' | 'postgresql' | 'mariadb' | 'mssql' | 'sqlite';

export type SqlEngineCap = 'Mysql' | 'Pg' | 'Mariadb' | 'Mssql' | 'Sqlite';

export type IndexMethodStyle = 'mysql' | 'pg' | 'tsql' | 'none';

export interface SqlEngineDescriptor {
  id: SqlEngineId;
  label: string;
  defaultPort: number | null;
  /** preload 方法名中缀: connectSqlite / queryMariadb / backupMssql … */
  cap: SqlEngineCap;
  /** 连接地址形态:hostPort(主机/端口/用户)vs file(SQLite 数据库文件)。 */
  addressMode: 'hostPort' | 'file';
  /** 树的顶层节点是 schema(pg/mssql)还是 database(mysql/mariadb/sqlite)。 */
  schemaQualified: boolean;
  /** dt-sql-parser 补全方言(4.6.1 无 tsql/sqlite 解析器)。 */
  completionDialect: 'mysql' | 'postgresql' | 'generic';
  monacoLanguage: 'sql' | 'pgsql';
  /** 索引方式子句形态:mysql `…(cols) USING m`;pg `ON t USING m (cols)`;tsql `CREATE [UNIQUE] [m] INDEX`;none 无。 */
  indexMethodStyle: IndexMethodStyle;
  /** 连接表单占位提示:hostPort 引擎的示例用户名/示例数据库(sqlite 两行均隐藏,留空)。 */
  placeholderUsername: string;
  placeholderDatabase: string;
  /** 连接列表分组头/行圆点的品牌识别色(hex)。 */
  accent: string;
  features: {
    tls: boolean;
    tunnel: boolean;
    explain: boolean;
    designer: boolean;
    backupRestore: boolean;
    indexMethods: string[];
    /** CREATE INDEX … WHERE <predicate> partial/filtered indexes (designer). */
    indexWhere: boolean;
    /** Per-column NULLS FIRST/LAST in index key parts (designer). */
    indexNulls: boolean;
    /** Server session manager (pg_stat_activity / processlist / dm_exec_sessions). */
    sessions: boolean;
    /** Lock/wait view (pg_locks / innodb_lock_waits / dm_tran_locks). */
    locks: boolean;
    /** User/role management list + create/drop (pg_roles / mysql.user). */
    users: boolean;
    /** TRUNCATE TABLE context-menu action (sqlite has none). */
    truncate: boolean;
    /** The bridge honors a query-level timeoutMs clamp. */
    queryTimeout: boolean;
  };
  columnTypes: string[];
}

/** mysql/mariadb are wire-compatible: they share the type list and capability set. */
const MYSQL_FAMILY_COLUMN_TYPES = ['tinyint(1)', 'tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'int unsigned', 'bigint unsigned', 'decimal(10,2)', 'float', 'double', 'bit(1)', 'boolean', 'char(36)', 'varchar(255)', 'tinytext', 'text', 'mediumtext', 'longtext', 'binary(16)', 'varbinary(255)', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'date', 'time', 'datetime', 'timestamp', 'year', 'json', "enum('a','b')", "set('a','b')"];

const MYSQL_FAMILY_FEATURES: SqlEngineDescriptor['features'] = {
  tls: true, tunnel: true, explain: true, designer: true, backupRestore: true,
  indexMethods: ['BTREE', 'HASH'], indexWhere: false, indexNulls: false, sessions: true, truncate: true, queryTimeout: true,
  locks: true, users: true,
};

export const SQL_ENGINES: readonly SqlEngineDescriptor[] = [
  { id: 'mysql',      label: 'MySQL',      defaultPort: 3306,  cap: 'Mysql',   addressMode: 'hostPort', schemaQualified: false, completionDialect: 'mysql',      monacoLanguage: 'sql',   indexMethodStyle: 'mysql',
    placeholderUsername: 'root',       placeholderDatabase: 'mysql',
    accent: '#1E7BA8',
    features: MYSQL_FAMILY_FEATURES,
    columnTypes: MYSQL_FAMILY_COLUMN_TYPES },
  { id: 'postgresql', label: 'PostgreSQL', defaultPort: 5432,  cap: 'Pg',      addressMode: 'hostPort', schemaQualified: true,  completionDialect: 'postgresql', monacoLanguage: 'pgsql', indexMethodStyle: 'pg',
    placeholderUsername: 'postgres',   placeholderDatabase: 'postgres',
    accent: '#336791',
    features: { tls: true, tunnel: true, explain: true, designer: true, backupRestore: true, indexMethods: ['btree', 'hash', 'gin', 'gist', 'spgist', 'brin'], indexWhere: true, indexNulls: true, sessions: true, truncate: true, queryTimeout: false, locks: true, users: true },
    columnTypes: ['smallint', 'integer', 'bigint', 'smallserial', 'serial', 'bigserial', 'numeric(10,2)', 'real', 'double precision', 'money', 'varchar(255)', 'text', 'bytea', 'date', 'time', 'timestamp', 'timestamptz', 'interval', 'boolean', 'json', 'jsonb', 'uuid', 'xml', 'inet', 'cidr', 'macaddr'] },
  { id: 'mariadb',    label: 'MariaDB',    defaultPort: 3306,  cap: 'Mariadb', addressMode: 'hostPort', schemaQualified: false, completionDialect: 'mysql',      monacoLanguage: 'sql',   indexMethodStyle: 'mysql',
    placeholderUsername: 'root',       placeholderDatabase: 'mysql',
    accent: '#A2593C',
    features: MYSQL_FAMILY_FEATURES,
    columnTypes: MYSQL_FAMILY_COLUMN_TYPES },
  { id: 'mssql',      label: 'SQL Server', defaultPort: 1433,  cap: 'Mssql',   addressMode: 'hostPort', schemaQualified: true,  completionDialect: 'generic',    monacoLanguage: 'sql',   indexMethodStyle: 'tsql',
    placeholderUsername: 'sa',         placeholderDatabase: 'master',
    accent: '#A93038',
    // tunnel: false (Ruling 8) — tedious dials TCP directly; there is no socket
    // to inject through an SSH tunnel, and the mssql bridge ignores opts.ssh.
    features: { tls: true, tunnel: false, explain: false, designer: true, backupRestore: true, indexMethods: ['CLUSTERED', 'NONCLUSTERED'], indexWhere: true, indexNulls: false, sessions: true, truncate: true, queryTimeout: true, locks: true, users: false },
    columnTypes: ['tinyint', 'smallint', 'int', 'bigint', 'decimal(10,2)', 'numeric(18,0)', 'money', 'smallmoney', 'float', 'real', 'bit', 'char(36)', 'nchar(10)', 'varchar(255)', 'nvarchar(255)', 'nvarchar(max)', 'binary(16)', 'varbinary(max)', 'date', 'time', 'smalldatetime', 'datetime2', 'datetimeoffset', 'uniqueidentifier', 'xml', 'sql_variant'] },
  { id: 'sqlite',     label: 'SQLite',     defaultPort: null,  cap: 'Sqlite',  addressMode: 'file',     schemaQualified: false, completionDialect: 'generic',    monacoLanguage: 'sql',   indexMethodStyle: 'none',
    placeholderUsername: '',           placeholderDatabase: '',
    accent: '#0F7B6C',
    features: { tls: false, tunnel: false, explain: true, designer: true, backupRestore: true, indexMethods: [], indexWhere: true, indexNulls: false, sessions: false, truncate: false, queryTimeout: false, locks: false, users: false },
    columnTypes: ['INTEGER', 'BIGINT', 'SMALLINT', 'TEXT', 'VARCHAR(255)', 'CHAR(36)', 'CLOB', 'REAL', 'DOUBLE', 'FLOAT', 'BLOB', 'NUMERIC', 'DECIMAL(10,2)', 'BOOLEAN', 'DATE', 'DATETIME', 'JSON'] },
];

/** Palette for database connection accent colors (card stripe). */
export const DB_ACCENT_COLORS = ['#336791', '#1E7BA8', '#0F7B6C', '#A2593C', '#A93038', '#7C3AED', '#B45309', '#4B5563'] as const;

export const SQL_ENGINE_BY_ID: Readonly<Record<SqlEngineId, SqlEngineDescriptor>> =
  Object.fromEntries(SQL_ENGINES.map((e) => [e.id, e])) as Readonly<Record<SqlEngineId, SqlEngineDescriptor>>;

export const isSqlEngineId = (p: unknown): p is SqlEngineId =>
  typeof p === 'string' && Object.hasOwn(SQL_ENGINE_BY_ID, p);

/** 标识符引用:mysql/mariadb 反引号、pg/sqlite 双引号、mssql 方括号(成对闭合)。 */
export const sqlQuoteIdent = (engine: SqlEngineId, ident: string): string => {
  if (engine === 'mysql' || engine === 'mariadb') return '`' + ident.replace(/`/g, '``') + '`';
  if (engine === 'mssql') return '[' + ident.replace(/]/g, ']]') + ']';
  return '"' + ident.replace(/"/g, '""') + '"';
};
