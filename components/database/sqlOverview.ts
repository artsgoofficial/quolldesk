/**
 * SQL overview dashboard query builders (per dialect, pure): server version,
 * database size (pre-humanized), live session count, table count, and (where
 * the engine exposes it) a top-tables-by-size list. The panel runs these
 * through the existing query channel — zero bridge changes.
 */
import type { SqlEngineId } from '../../domain/models/dbEngines';

export interface OverviewQuerySet {
  server: string;
  dbSize: string;
  sessions: string;
  tables: string;
  /** Top tables by total size, largest first (omit when unsupported). */
  tablesTop?: string;
}

const QUERY_SETS: Record<SqlEngineId, OverviewQuerySet> = {
  postgresql: {
    server: 'SELECT version() AS v',
    dbSize: "SELECT pg_size_pretty(pg_database_size(current_database())) AS size",
    sessions: 'SELECT count(*)::text AS c FROM pg_stat_activity WHERE datname = current_database()',
    tables: "SELECT count(*)::text AS c FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')",
    tablesTop:
      "SELECT c.relname AS name, pg_size_pretty(pg_total_relation_size(c.oid)) AS size " +
      'FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ' +
      "WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema') " +
      'ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 10',
  },
  mysql: {
    server: 'SELECT version() AS v',
    dbSize: "SELECT CONCAT(ROUND(SUM(data_length + index_length) / 1024 / 1024), ' MB') AS size FROM information_schema.tables WHERE table_schema = DATABASE()",
    sessions: 'SELECT COUNT(*) AS c FROM information_schema.processlist',
    tables: 'SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = \'BASE TABLE\'',
    tablesTop:
      'SELECT table_name AS name, CONCAT(ROUND((data_length + index_length) / 1024 / 1024), \' MB\') AS size ' +
      'FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = \'BASE TABLE\' ' +
      'ORDER BY (data_length + index_length) DESC LIMIT 10',
  },
  mariadb: {
    server: 'SELECT version() AS v',
    dbSize: "SELECT CONCAT(ROUND(SUM(data_length + index_length) / 1024 / 1024), ' MB') AS size FROM information_schema.tables WHERE table_schema = DATABASE()",
    sessions: 'SELECT COUNT(*) AS c FROM information_schema.processlist',
    tables: 'SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = \'BASE TABLE\'',
    tablesTop:
      'SELECT table_name AS name, CONCAT(ROUND((data_length + index_length) / 1024 / 1024), \' MB\') AS size ' +
      'FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = \'BASE TABLE\' ' +
      'ORDER BY (data_length + index_length) DESC LIMIT 10',
  },
  mssql: {
    server: 'SELECT @@VERSION AS v',
    dbSize: "SELECT CAST(SUM(size) * 8 / 1024 AS nvarchar(50)) + ' MB' AS size FROM sys.database_files",
    sessions: 'SELECT COUNT(*) AS c FROM sys.dm_exec_sessions WHERE is_user_process = 1',
    tables: "SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'",
  },
  sqlite: {
    server: 'SELECT sqlite_version() AS v',
    dbSize: "SELECT ((SELECT page_count FROM pragma_page_count()) * (SELECT page_size FROM pragma_page_size()) / 1024) || ' KB' AS size",
    sessions: "SELECT '0' AS c",
    tables: "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  },
};

export const overviewQueries = (dialect: SqlEngineId): OverviewQuerySet => QUERY_SETS[dialect];
