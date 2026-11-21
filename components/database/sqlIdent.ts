/**
 * DDL text builders for the schema-tree context menus (truncate/drop/rename/
 * seeded SELECT). Pure string builders — execution and confirmation live in
 * DatabaseWorkbench; the destructive statements run through the existing
 * query bridge so the server-side privilege model stays the single gate.
 */

export type SqlDialect = 'mysql' | 'postgresql';
export type SqlObjectKind = 'table' | 'view';

/** Quote one identifier with the dialect's quote character (doubling escapes). */
export const quoteIdent = (dialect: SqlDialect, ident: string): string =>
  dialect === 'mysql'
    ? '`' + ident.replace(/`/g, '``') + '`'
    : '"' + ident.replace(/"/g, '""') + '"';

/** Schema/database-qualified object name (`db`.`t` / "schema"."t"). */
export const qualified = (dialect: SqlDialect, db: string | undefined, object: string): string =>
  db ? `${quoteIdent(dialect, db)}.${quoteIdent(dialect, object)}` : quoteIdent(dialect, object);

/** Grid-style seed query for a table/view opened from the tree ("新建查询"). */
export const seedSelect = (dialect: SqlDialect, db: string | undefined, object: string): string =>
  `SELECT * FROM ${qualified(dialect, db, object)} LIMIT 100;`;

export const truncateTable = (dialect: SqlDialect, db: string | undefined, table: string): string =>
  `TRUNCATE TABLE ${qualified(dialect, db, table)};`;

export const dropTable = (dialect: SqlDialect, db: string | undefined, table: string): string =>
  `DROP TABLE ${qualified(dialect, db, table)};`;

export const dropView = (dialect: SqlDialect, db: string | undefined, view: string): string =>
  `DROP VIEW ${qualified(dialect, db, view)};`;

/**
 * Rename a table or view. MySQL renames both with RENAME TABLE; pg needs
 * ALTER TABLE vs ALTER VIEW (ALTER TABLE errors on a view).
 */
export const renameObject = (
  dialect: SqlDialect,
  db: string | undefined,
  from: string,
  to: string,
  kind: SqlObjectKind = 'table',
): string => {
  if (dialect === 'mysql') {
    return `RENAME TABLE ${qualified(dialect, db, from)} TO ${qualified(dialect, db, to)};`;
  }
  const alter = kind === 'view' ? 'ALTER VIEW' : 'ALTER TABLE';
  return `${alter} ${qualified(dialect, db, from)} RENAME TO ${quoteIdent(dialect, to)};`;
};

/**
 * Drop a tree "database" node: a real database on mysql, a schema on pg.
 * The pg form CASCADEs — the confirm dialog must warn that every table in
 * the schema goes with it.
 */
export const dropDatabase = (dialect: SqlDialect, name: string): string =>
  dialect === 'mysql' ? `DROP DATABASE ${quoteIdent(dialect, name)};` : `DROP SCHEMA ${quoteIdent(dialect, name)} CASCADE;`;
