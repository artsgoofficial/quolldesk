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
  features: {
    tls: boolean;
    tunnel: boolean;
    explain: boolean;
    designer: boolean;
    backupRestore: boolean;
    indexMethods: string[];
  };
  columnTypes: string[];
}

export const SQL_ENGINES: readonly SqlEngineDescriptor[] = [
  { id: 'mysql',      label: 'MySQL',      defaultPort: 3306,  cap: 'Mysql',   addressMode: 'hostPort', schemaQualified: false, completionDialect: 'mysql',      monacoLanguage: 'sql',   indexMethodStyle: 'mysql',
    features: { tls: true, tunnel: true, explain: true, designer: true, backupRestore: true, indexMethods: ['BTREE', 'HASH'] },
    columnTypes: ['tinyint(1)', 'int', 'bigint', 'decimal(10,2)', 'varchar(255)', 'char(36)', 'text', 'date', 'datetime', 'timestamp', 'json', 'boolean'] },
  { id: 'postgresql', label: 'PostgreSQL', defaultPort: 5432,  cap: 'Pg',      addressMode: 'hostPort', schemaQualified: true,  completionDialect: 'postgresql', monacoLanguage: 'pgsql', indexMethodStyle: 'pg',
    features: { tls: true, tunnel: true, explain: true, designer: true, backupRestore: true, indexMethods: ['btree', 'hash', 'gin', 'gist', 'spgist', 'brin'] },
    columnTypes: ['smallint', 'integer', 'bigint', 'numeric(10,2)', 'varchar(255)', 'text', 'date', 'timestamp', 'timestamptz', 'boolean', 'jsonb', 'uuid'] },
  { id: 'mariadb',    label: 'MariaDB',    defaultPort: 3306,  cap: 'Mariadb', addressMode: 'hostPort', schemaQualified: false, completionDialect: 'mysql',      monacoLanguage: 'sql',   indexMethodStyle: 'mysql',
    features: { tls: true, tunnel: true, explain: true, designer: true, backupRestore: true, indexMethods: ['BTREE', 'HASH'] },
    columnTypes: ['tinyint(1)', 'int', 'bigint', 'decimal(10,2)', 'varchar(255)', 'char(36)', 'text', 'date', 'datetime', 'timestamp', 'json', 'boolean'] },
  { id: 'mssql',      label: 'SQL Server', defaultPort: 1433,  cap: 'Mssql',   addressMode: 'hostPort', schemaQualified: true,  completionDialect: 'generic',    monacoLanguage: 'sql',   indexMethodStyle: 'tsql',
    // tunnel: false (Ruling 8) — tedious dials TCP directly; there is no socket
    // to inject through an SSH tunnel, and the mssql bridge ignores opts.ssh.
    features: { tls: true, tunnel: false, explain: false, designer: true, backupRestore: true, indexMethods: ['CLUSTERED', 'NONCLUSTERED'] },
    columnTypes: ['int', 'bigint', 'decimal(10,2)', 'nvarchar(255)', 'nvarchar(max)', 'char(36)', 'date', 'datetime2', 'smalldatetime', 'bit', 'float', 'real', 'uniqueidentifier', 'varbinary(max)', 'xml'] },
  { id: 'sqlite',     label: 'SQLite',     defaultPort: null,  cap: 'Sqlite',  addressMode: 'file',     schemaQualified: false, completionDialect: 'generic',    monacoLanguage: 'sql',   indexMethodStyle: 'none',
    features: { tls: false, tunnel: false, explain: true, designer: true, backupRestore: true, indexMethods: [] },
    columnTypes: ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC', 'BOOLEAN', 'DATE', 'DATETIME', 'JSON', 'VARCHAR(255)', 'BIGINT', 'DOUBLE'] },
];

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
