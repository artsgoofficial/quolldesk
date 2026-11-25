/**
 * Shared job builder for panels that walk the schema tree table-by-table
 * (ER diagram, full-database search). One place decides whether the tree's
 * top-level name is a SQL qualifier, so ER and search can't drift apart.
 */
import { SQL_ENGINE_BY_ID, type SqlEngineId } from '../../domain/models/dbEngines';

export interface SchemaJob {
  /** Owning schema/database for SQL qualification; null = single implicit database. */
  schema: string | null;
  table: string;
}

/**
 * `schemaQualified` on the engine record is a tree-structure flag (pg/mssql
 * tree tops are schemas, mysql family tops are databases) — it does NOT mean
 * "table refs need no qualifier". Every server-backed engine still needs the
 * top-level name attached at SQL time; sqlite is file-backed with a single
 * implicit database. Building jobs with schema:null for mysql/mariadb made
 * tableMeta/probes resolve against the connection's default database instead
 * of the table's own database ("No database selected", or
 * "Table 'defaultdb.foreignTable' doesn't exist").
 */
export function buildSchemaJobs(
  dialect: SqlEngineId,
  databases: { name: string; tables?: readonly string[]; views?: readonly string[] }[],
  selectedSchema: string | undefined,
  opts: { includeViews?: boolean } = {},
): SchemaJob[] {
  const qualified = SQL_ENGINE_BY_ID[dialect].addressMode !== 'file';
  const jobs: SchemaJob[] = [];
  for (const db of databases) {
    if (qualified && selectedSchema && db.name !== selectedSchema) continue;
    for (const table of db.tables ?? []) jobs.push({ schema: qualified ? db.name : null, table });
    if (opts.includeViews) {
      for (const view of db.views ?? []) jobs.push({ schema: qualified ? db.name : null, table: view });
    }
  }
  return jobs;
}
