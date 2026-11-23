import { sqlQuoteIdent, type SqlEngineId } from '../../domain/models/dbEngines';

/** The four DML templates offered by the tree's 生成 SQL submenu. */
export const GENERATE_KINDS = ['select', 'insert', 'update', 'delete'] as const;
export type SqlGenerateKind = (typeof GENERATE_KINDS)[number];

const splitNames = (raw: string): string[] =>
  raw.split(',').map((c) => c.trim()).filter(Boolean);

/**
 * Generate one DML statement for a table (DBeaver-style SQL generation).
 * - select: full column list.
 * - insert: one placeholder row of quoted empty strings (fill and run).
 * - update/delete: restricted by the primary key columns; with NO pk at all
 *   the statement is guarded by `WHERE 1 = 0` so it can never sweep the
 *   whole table — the safety comment travels with the statement.
 * Empty table name returns '' (the caller guards the menu item anyway).
 */
export const generateSql = (
  dialect: SqlEngineId,
  kind: SqlGenerateKind,
  table: string,
  columns: string[],
  pkColumns: string[],
): string => {
  const name = table.trim();
  if (!name) return '';
  const q = (id: string) => sqlQuoteIdent(dialect, id);
  const ref = q(name);
  const colList = columns.map(q).join(', ');
  if (kind === 'select') {
    return `SELECT ${colList} FROM ${ref};`;
  }
  if (kind === 'insert') {
    const placeholders = columns.map(() => "''").join(', ');
    return `INSERT INTO ${ref} (${colList}) VALUES (${placeholders});`;
  }
  const pk = pkColumns.map(q).map((c) => `${c} = ''`).join(' AND ');
  const guard = pk || '1 = 0';
  if (kind === 'update') {
    const settable = columns.filter((c) => !pkColumns.includes(c));
    const setClause = settable.map((c) => `${q(c)} = ''`).join(', ') || '1 = 1';
    if (!pk) return `UPDATE ${ref} SET ${setClause} WHERE 1 = 0; /* 无主键，已阻止全表更新 */`;
    return `UPDATE ${ref} SET ${setClause} WHERE ${guard};`;
  }
  if (!pk) return `DELETE FROM ${ref} WHERE 1 = 0; /* 无主键，已阻止全表删除 */`;
  return `DELETE FROM ${ref} WHERE ${guard};`;
};

/** Menu label key suffix per kind (db.tree.menu.genSelect …). */
export const generateKindLabelKey = (kind: SqlGenerateKind): string => `db.tree.menu.gen${kind[0].toUpperCase()}${kind.slice(1)}`;

/** Split a comma-separated column list from the designer-style inputs. */
export const splitColumnList = splitNames;
