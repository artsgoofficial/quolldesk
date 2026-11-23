import { sqlQuoteIdent } from '../../domain/models/dbEngines';

import type { SqlEngineId } from '../../domain/models/dbEngines';

/** One column of a table as reported by tableMeta (name + data type). */
export interface SearchColumnMeta {
  name: string;
  dataType: string;
}

/** A database-wide search hit: one table whose object name or data matched. */
export interface SqlSearchHit {
  schema: string | null;
  table: string;
  /** Object-name hit info (table/view name matched the term). */
  nameHit: boolean;
  /** Column names whose object name matched the term. */
  matchedColumnNames: string[];
  /** Data hit info (probe SELECT returned rows). */
  dataHit: boolean;
  /** Sample rows (raw driver rows, capped by the probe LIMIT). */
  sampleRows: Record<string, unknown>[];
}

/** Case-insensitive containment match on trimmed terms (LIKE '%q%' semantics). */
export const matchesTerm = (name: string, term: string): boolean => {
  const needle = term.trim().toLowerCase();
  if (!needle) return false;
  return name.toLowerCase().includes(needle);
};

/**
 * Columns whose type a LIKE probe can meaningfully search: character
 * families, text, and the json family (cast to text server-side). Numbers and
 * timestamps are excluded — searching them is noise in practice. Accepts both
 * `dataType` (bridge tableMeta shape) and `type` keys defensively.
 */
export const textLikeColumns = (columns: SearchColumnMeta[], _dialect: SqlEngineId): SearchColumnMeta[] =>
  columns.filter((c) => {
    const t = (c.dataType ?? (c as unknown as { type?: string }).type ?? '').toLowerCase();
    return t.startsWith('char') || t.startsWith('varchar') || t.startsWith('nchar')
      || t.startsWith('nvarchar') || t === 'text' || t.startsWith('tinytext')
      || t.startsWith('mediumtext') || t.startsWith('longtext') || t === 'json' || t === 'jsonb';
  });

/**
 * Escape LIKE wildcards so the term is matched literally (searching "100%"
 * does not turn into an everything-match). Backslash first, then % and _;
 * paired with an explicit ESCAPE '\' clause in the generated SQL.
 */
const escapeLikePattern = (term: string): string =>
  term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');

/**
 * One parameterized probe SELECT per table: every text-like column OR-ed into
 * a single WHERE, values as the escaped %term% pattern (parameterized — term
 * content is never interpolated into SQL). Returns null when there is nothing
 * to search. mssql keeps the LIMIT form: T-SQL has no LIMIT, the panel uses a
 * TOP wrapper instead (see SqlSearchPanel).
 */
export const buildProbeSql = (
  dialect: SqlEngineId,
  tableRef: string,
  columnNames: string[],
  term: string,
  limit: number,
): { sql: string; values: unknown[] } | null => {
  if (columnNames.length === 0) return null;
  const q = (id: string) => sqlQuoteIdent(dialect, id);
  const pattern = `%${escapeLikePattern(term)}%`;
  if (dialect === 'postgresql') {
    const where = columnNames.map((c) => `${q(c)}::text ILIKE $1 ESCAPE '\\'`).join(' OR ');
    return { sql: `SELECT * FROM ${tableRef} WHERE ${where} LIMIT ${limit}`, values: [pattern] };
  }
  if (dialect === 'mysql' || dialect === 'mariadb') {
    const where = columnNames.map((c) => `${q(c)} LIKE ? ESCAPE '\\\\'`).join(' OR ');
    return { sql: `SELECT * FROM ${tableRef} WHERE ${where} LIMIT ${limit}`, values: [pattern] };
  }
  if (dialect === 'sqlite') {
    const where = columnNames.map((c) => `${q(c)} LIKE ? ESCAPE '\\'`).join(' OR ');
    return { sql: `SELECT * FROM ${tableRef} WHERE ${where} LIMIT ${limit}`, values: [pattern] };
  }
  const where = columnNames.map((c) => `${q(c)} LIKE @0 ESCAPE '\\'`).join(' OR ');
  return { sql: `SELECT TOP ${limit} * FROM ${tableRef} WHERE ${where}`, values: [pattern] };
};
