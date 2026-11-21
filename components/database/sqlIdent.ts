/**
 * DDL text builders for the schema-tree context menus (truncate/drop/rename/
 * seeded SELECT). Pure string builders — execution and confirmation live in
 * DatabaseWorkbench; the destructive statements run through the existing
 * query bridge so the server-side privilege model stays the single gate.
 *
 * Every builder takes the registry engine id (SqlEngineId); quoting comes
 * from the shared sqlQuoteIdent helper. Builders whose action does not exist
 * on an engine (sqlite truncate/drop-database) return null — the workbench
 * omits those menu entries instead of showing dead actions.
 */

import { sqlQuoteIdent, type SqlEngineId } from '../../domain/models/dbEngines';

export type SqlObjectKind = 'table' | 'view';

/** Quote one identifier with the engine's quote character (doubling escapes). */
export const quoteIdent = (engine: SqlEngineId, ident: string): string => sqlQuoteIdent(engine, ident);

/** Schema/database-qualified object name (`db`.`t` / "schema"."t" / [schema].[t]). */
export const qualified = (engine: SqlEngineId, db: string | undefined, object: string): string =>
  db ? `${quoteIdent(engine, db)}.${quoteIdent(engine, object)}` : quoteIdent(engine, object);

/** Grid-style seed query for a table/view opened from the tree ("新建查询"). */
export const seedSelect = (engine: SqlEngineId, db: string | undefined, object: string): string =>
  engine === 'mssql'
    ? `SELECT TOP 100 * FROM ${qualified(engine, db, object)};`
    : `SELECT * FROM ${qualified(engine, db, object)} LIMIT 100;`;

/** TRUNCATE TABLE; sqlite has no TRUNCATE (null → the caller hides the menu). */
export const truncateTable = (engine: SqlEngineId, db: string | undefined, table: string): string | null =>
  engine === 'sqlite' ? null : `TRUNCATE TABLE ${qualified(engine, db, table)};`;

export const dropTable = (engine: SqlEngineId, db: string | undefined, table: string): string =>
  `DROP TABLE ${qualified(engine, db, table)};`;

export const dropView = (engine: SqlEngineId, db: string | undefined, view: string): string =>
  `DROP VIEW ${qualified(engine, db, view)};`;

/**
 * Rename a table or view. mysql/mariadb rename both with RENAME TABLE;
 * mssql goes through sp_rename (tables and views alike — the new name is a
 * plain string literal); pg/sqlite need ALTER TABLE vs ALTER VIEW (ALTER
 * TABLE errors on a view).
 */
export const renameObject = (
  engine: SqlEngineId,
  db: string | undefined,
  from: string,
  to: string,
  kind: SqlObjectKind = 'table',
): string => {
  if (engine === 'mysql' || engine === 'mariadb') {
    return `RENAME TABLE ${qualified(engine, db, from)} TO ${qualified(engine, db, to)};`;
  }
  if (engine === 'mssql') {
    // sp_rename takes both names as string literals; the object reference is
    // the bracket-quoted identifier inside the first literal.
    return `EXEC sp_rename '${quoteIdent(engine, from).replace(/'/g, "''")}', '${to.replace(/'/g, "''")}';`;
  }
  const alter = kind === 'view' ? 'ALTER VIEW' : 'ALTER TABLE';
  return `${alter} ${qualified(engine, db, from)} RENAME TO ${quoteIdent(engine, to)};`;
};

/**
 * Drop a tree "database" node: a real database on mysql/mariadb, a schema on
 * pg/mssql (pg CASCADEs — the confirm dialog must warn that every table in
 * the schema goes with it; mssql has no CASCADE form). sqlite is a
 * single-file database — null → the caller hides the menu.
 */
export const dropDatabase = (engine: SqlEngineId, name: string): string | null => {
  if (engine === 'mysql' || engine === 'mariadb') return `DROP DATABASE ${quoteIdent(engine, name)};`;
  if (engine === 'postgresql') return `DROP SCHEMA ${quoteIdent(engine, name)} CASCADE;`;
  if (engine === 'mssql') return `DROP SCHEMA ${quoteIdent(engine, name)};`;
  return null;
};
