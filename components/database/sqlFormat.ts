import { format, type SqlLanguage } from 'sql-formatter';

import type { SqlEngineId } from '../../domain/models/dbEngines';

/** sql-formatter language per engine (mssql speaks T-SQL = 'transactsql'). */
export const SQL_FORMAT_LANGUAGE: Record<SqlEngineId, SqlLanguage> = {
  mysql: 'mysql',
  mariadb: 'mariadb',
  postgresql: 'postgresql',
  mssql: 'transactsql',
  sqlite: 'sqlite',
};

/**
 * Format one SQL script for the editor's Format action (toolbar button +
 * Shift+Alt+F). Keywords go upper-case, 2-space indent (editor tabSize=2).
 * Empty/whitespace-only input passes through untouched so the action on an
 * empty tab is a no-op instead of emitting a stray newline.
 */
export const formatSql = (dialect: SqlEngineId, sql: string): string => {
  const raw = sql.trim();
  if (!raw) return sql;
  return format(raw, { language: SQL_FORMAT_LANGUAGE[dialect], keywordCase: 'upper', tabWidth: 2 });
};
