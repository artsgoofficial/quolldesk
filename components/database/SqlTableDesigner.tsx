import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Play, Plus, RotateCcw, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
// The @/ alias is the repo's sanctioned path for component-layer imports of
// infrastructure services (relative ../../infrastructure imports are eslint-restricted).
import { databaseClient, dbErrorMessage } from '@/infrastructure/services/databaseClient';
import { fetchSqlSchemaTree } from '@/infrastructure/services/sqlSchemaTreeCache';
import {
  SQL_ENGINES,
  SQL_ENGINE_BY_ID,
  sqlQuoteIdent,
  type SqlEngineId,
} from '../../domain/models/dbEngines';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { toast } from '../ui/toast';

interface SqlTableDesignerProps {
  connectionId: string;
  dialect: SqlEngineId;
  schema?: string;
  /** Set to prefill from an existing table (edit mode); null = create mode. */
  editingTable?: string | null;
  onClose: () => void;
  /** Called after the DDL executed successfully; the workbench bumps its refreshToken. */
  onDone: () => void;
}

interface DesignerColumn {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string;
  pk: boolean;
}

/** One key part of an index: a column name, or a pg expression (`lower(x)`). */
export interface IndexColumnEntry {
  expr: string;
  /** Sort DESC for this key (legal on every engine; InnoDB ignores it). */
  desc?: boolean;
  /** pg-only NULLS FIRST/LAST ordering for this key. */
  nulls?: 'first' | 'last';
}

/**
 * Editable index row. Columns are one entry per key part (sub-row editor,
 * DBeaver-style); the entry order IS the key order (leftmost-prefix
 * semantics), so sub-row reorder buttons matter.
 */
interface DesignerIndex {
  name: string;
  unique: boolean;
  columns: IndexColumnEntry[];
  /** Access method (USING clause); empty string = dialect default. */
  method: string;
  /** Partial/filtered predicate: pg WHERE / mssql filtered / sqlite partial. */
  where: string;
  /** Draft-local editor state: column sub-rows visible (never persisted). */
  open?: boolean;
}

/**
 * Editable FK row. columns / refColumns stay comma-separated text (composite
 * FKs supported; entry order pairs the two lists). Actions default empty =
 * dialect NO ACTION.
 */
interface DesignerForeignKey {
  name: string;
  columns: string;
  refTable: string;
  refColumns: string;
  onDelete: string;
  onUpdate: string;
}

/** Prefilled snapshot of the existing table used as the ALTER diff base. */
interface OriginalTable {
  columns: DesignerColumn[];
  indexes: { name: string; unique: boolean; columns: string[]; method?: string | null; where?: string }[];
  foreignKeys: { name: string | null; columns: string[]; refTable: string; refSchema: string | null; refColumns: (string | null)[]; onDelete: string | null; onUpdate: string | null }[];
  /** First PK column (bridge-reported primaryKey / PRI flag). */
  pkColumn: string | null;
  /** PK constraint name (pg DROP CONSTRAINT; mysql is always "PRIMARY"). */
  pkConstraintName: string | null;
}

type Dialect = SqlEngineId;

// Column-type quick-picks for the designer's type menu. The type input stays
// free-text (bridge-reported types render verbatim), so this list only feeds
// the picker — each engine offers exactly what it supports. Fed from the
// SQL_ENGINES registry (values are the original per-dialect literals).
export const COLUMN_TYPES: Record<Dialect, string[]> = Object.fromEntries(
  SQL_ENGINES.map((e) => [e.id, e.columnTypes]),
) as Record<Dialect, string[]>;

// Dropdown choices for the index access method (USING clause). mysql deprecates
// HASH outside MEMORY/NDB but accepts the syntax (server silently uses BTREE
// on InnoDB); FULLTEXT/SPATIAL are separate index categories, not USING methods.
const INDEX_METHODS: Record<Dialect, string[]> = Object.fromEntries(
  SQL_ENGINES.map((e) => [e.id, e.features.indexMethods]),
) as Record<Dialect, string[]>;

/** Canonical FK referential actions (empty draft value = NO ACTION). */
const FK_ACTIONS = ['CASCADE', 'RESTRICT', 'SET NULL', 'SET DEFAULT', 'NO ACTION'];

const DEFAULT_INDEX_METHOD: Record<Dialect, string> = {
  mysql: 'BTREE',
  mariadb: 'BTREE',
  postgresql: 'btree',
  mssql: 'NONCLUSTERED',
  sqlite: '',
};

// Free-text type input fallback per engine (mysql-family shares varchar(255)).
const DEFAULT_COLUMN_TYPE: Record<Dialect, string> = {
  mysql: 'varchar(255)',
  mariadb: 'varchar(255)',
  postgresql: 'text',
  mssql: 'nvarchar(255)',
  sqlite: 'TEXT',
};

// Map a bridge-reported access method onto the engine's dropdown value (pg
// amname is lowercase, mysql Index_type uppercase, mssql syntax is uppercase);
// unknown values pass through so a future server-side method still shows
// instead of degrading.
export const normalizeIndexMethod = (dialect: Dialect, raw?: string | null): string => {
  const v = (raw ?? '').trim();
  if (!v) return DEFAULT_INDEX_METHOD[dialect];
  return INDEX_METHODS[dialect].find((m) => m.toLowerCase() === v.toLowerCase()) ?? v;
};

// USING fragment value: empty for the engine default (and empty drafts) so
// existing default-method indexes diff clean, while an explicit method change
// still triggers the drop+recreate walk.
const effectiveIndexMethod = (dialect: Dialect, method: string): string => {
  const v = method.trim();
  if (!v || v.toLowerCase() === DEFAULT_INDEX_METHOD[dialect].toLowerCase()) return '';
  return v;
};

// Engine-wide identifier quoting (backticks / double quotes / brackets).
const quoteIdent = (dialect: Dialect, id: string): string => sqlQuoteIdent(dialect, id);

/**
 * SQL text for one index key part. pg expressions (entries containing a
 * paren — no legal identifier has one) pass through unquoted so `lower(email)`
 * / `(a || b)` work; plain names are quoted as identifiers on every engine.
 * DESC renders everywhere (syntax is universal); NULLS renders only on pg,
 * where the other engines would reject the keyword outright.
 */
const renderIndexColumn = (dialect: Dialect, entry: IndexColumnEntry): string => {
  const raw = entry.expr.trim();
  if (!raw) return '';
  const base = dialect === 'postgresql' && /[()]/.test(raw) ? raw : quoteIdent(dialect, raw);
  const desc = entry.desc ? ' DESC' : '';
  const nulls = dialect === 'postgresql' && entry.nulls
    ? ` NULLS ${entry.nulls === 'first' ? 'FIRST' : 'LAST'}`
    : '';
  return base + desc + nulls;
};

const renderIndexColumns = (dialect: Dialect, entries: IndexColumnEntry[]): string[] =>
  entries.map((e) => renderIndexColumn(dialect, e)).filter(Boolean);

/** Stable diff key for one entry (expr + desc + nulls, trimmed). */
const indexColumnKey = (entry: IndexColumnEntry): string => {
  const raw = entry.expr.trim();
  if (!raw) return '';
  return raw + (entry.desc ? ' DESC' : '') + (entry.nulls ? ` NULLS ${entry.nulls === 'first' ? 'FIRST' : 'LAST'}` : '');
};

const columnTypeOrDefault = (dialect: Dialect, type: string): string =>
  type.trim() || DEFAULT_COLUMN_TYPE[dialect];

// DEFAULT text passes through exactly as typed (0, CURRENT_TIMESTAMP, 'abc');
// an unquoted string default is a syntax error the user sees in the preview —
// the textarea is editable and executing is an explicit, confirmed action.
const columnDefSql = (dialect: Dialect, col: DesignerColumn): string => {
  const parts = [quoteIdent(dialect, col.name.trim()), columnTypeOrDefault(dialect, col.type)];
  if (!col.nullable) parts.push('NOT NULL');
  const def = col.defaultValue.trim();
  if (def) parts.push(`DEFAULT ${def}`);
  return parts.join(' ');
};

const emptyColumn = (): DesignerColumn => ({ name: '', type: '', nullable: true, defaultValue: '', pk: false });

/**
 * CREATE INDEX with the engine's indexMethodStyle USING placement:
 * mysql/mariadb put USING after the column list, pg between ON and the
 * columns, tsql between UNIQUE and INDEX, 'none' (sqlite) never emits one.
 */
const buildIndexStatement = (
  dialect: Dialect,
  opts: { unique: boolean; name: string; tableRef: string; columns: IndexColumnEntry[]; method: string; where: string },
): string => {
  const q = (id: string) => quoteIdent(dialect, id);
  const style = SQL_ENGINE_BY_ID[dialect].indexMethodStyle;
  const using = style === 'none' ? '' : effectiveIndexMethod(dialect, opts.method);
  const cols = renderIndexColumns(dialect, opts.columns).join(', ');
  const uniquePrefix = opts.unique ? 'UNIQUE ' : '';
  // Partial/filtered predicate (pg / mssql / sqlite): appended at the end of
  // the statement; gated on the registry so a mysql draft can never emit one.
  const where = opts.where.trim() && SQL_ENGINE_BY_ID[dialect].features.indexWhere
    ? ` WHERE ${opts.where.trim()}`
    : '';
  if (style === 'tsql') {
    return `CREATE ${uniquePrefix}${using ? `${using} ` : ''}INDEX ${q(opts.name)} ON ${opts.tableRef} (${cols})${where}`;
  }
  if (style === 'pg') {
    return `CREATE ${uniquePrefix}INDEX ${q(opts.name)} ON ${opts.tableRef}${using ? ` USING ${using}` : ''} (${cols})${where}`;
  }
  return `CREATE ${uniquePrefix}INDEX ${q(opts.name)} ON ${opts.tableRef} (${cols})${using ? ` USING ${using}` : ''}${where}`;
};

export const buildCreateTable = (
  dialect: Dialect,
  table: string,
  cols: DesignerColumn[],
  indexes: DesignerIndex[],
  tableRef: string,
  foreignKeys: DesignerForeignKey[] = [],
): string => {
  const q = (id: string) => quoteIdent(dialect, id);
  const named = cols.filter((c) => c.name.trim());
  if (!table.trim() || named.length === 0) return '';
  const lines = named.map((c) => `  ${columnDefSql(dialect, c)}`);
  const pk = named.find((c) => c.pk);
  if (pk) lines.push(`  PRIMARY KEY (${q(pk.name.trim())})`);
  // Inline FK constraints ride the CREATE TABLE for mysql-family and sqlite
  // (their ALTER has no ADD CONSTRAINT form in this designer); pg/mssql get
  // standalone ALTER TABLE statements below instead.
  if (dialect === 'mysql' || dialect === 'mariadb' || dialect === 'sqlite') {
    for (const fk of foreignKeys) {
      if (!fk.refTable.trim() || fkColumnKeys(fk.columns).length === 0 || fkColumnKeys(fk.refColumns).length === 0) continue;
      lines.push(`  ${buildFkConstraintSql(dialect, fk)}`);
    }
  }
  const statements = [`CREATE TABLE ${tableRef} (\n${lines.join(',\n')}\n)`];
  for (const idx of indexes) {
    const idxCols = renderIndexColumns(dialect, idx.columns);
    if (!idx.name.trim() || idxCols.length === 0) continue;
    statements.push(buildIndexStatement(dialect, {
      unique: idx.unique,
      name: idx.name.trim(),
      tableRef,
      columns: idx.columns,
      method: idx.method,
      where: idx.where,
    }));
  }
  if (dialect === 'postgresql' || dialect === 'mssql') {
    for (const fk of foreignKeys) {
      if (!fk.refTable.trim() || fkColumnKeys(fk.columns).length === 0 || fkColumnKeys(fk.refColumns).length === 0) continue;
      statements.push(`ALTER TABLE ${tableRef} ADD ${buildFkConstraintSql(dialect, fk)}`);
    }
  }
  return statements.join(';\n') + ';';
};

/**
 * Shared index-diff walk (ALTER ADD/DROP INDEX for mysql, CREATE/DROP INDEX
 * for pg): add missing indexes, recreate changed ones (unique / columns /
 * access method), drop removed ones. `defaultMethod` folds the dialect's
 * default into the comparison so an absent bridge report never fakes a change.
 */
export const diffIndexes = (
  originalIndexes: OriginalTable['indexes'],
  currentIndexes: DesignerIndex[],
  opts: {
    addIndex: (idx: { name: string; unique: boolean; columns: IndexColumnEntry[]; method: string; where: string }) => string;
    dropIndex: (name: string) => string;
    defaultMethod: string;
  },
): string[] => {
  const statements: string[] = [];
  // Fold the default away: '' and 'btree' compare equal, case-insensitively.
  const methodKey = (v: string | undefined | null) => {
    const s = (v ?? '').trim().toLowerCase();
    return s === opts.defaultMethod.toLowerCase() ? '' : s;
  };
  const liveIndexes = currentIndexes.filter((i) => i.name.trim() && i.columns.some((c) => indexColumnKey(c)));
  const originalByName = new Map(originalIndexes.map((i) => [i.name, i]));
  for (const idx of liveIndexes) {
    const name = idx.name.trim();
    const before = originalByName.get(name);
    // Entry keys carry desc/nulls so adding a sort order to a bridge-loaded
    // plain index correctly recreates it; empty (unnamed) entries drop out.
    const nextKeys = idx.columns.map(indexColumnKey).filter(Boolean);
    if (!before) {
      statements.push(opts.addIndex({ name, unique: idx.unique, columns: idx.columns, method: idx.method, where: idx.where }));
    } else if (
      (before.unique ?? false) !== idx.unique
      || before.columns.join(',') !== nextKeys.join(',')
      || methodKey(before.method) !== methodKey(idx.method)
      || (before.where ?? '').trim() !== idx.where.trim()
    ) {
      statements.push(opts.dropIndex(name));
      statements.push(opts.addIndex({ name, unique: idx.unique, columns: idx.columns, method: idx.method, where: idx.where }));
    }
  }
  for (const before of originalIndexes) {
    if (!liveIndexes.some((i) => i.name.trim() === before.name)) {
      statements.push(opts.dropIndex(before.name));
    }
  }
  return statements;
};

/**
 * FK constraint SQL fragment (without ALTER TABLE prefix): mysql puts no
 * constraint name on generated inline defs only when the draft has none.
 * Actions render only when set (empty = dialect NO ACTION default).
 */
const buildFkConstraintSql = (
  dialect: Dialect,
  fk: { name: string; columns: string; refTable: string; refColumns: string; onDelete: string; onUpdate: string },
): string => {
  const q = (id: string) => quoteIdent(dialect, id);
  const cols = fk.columns.split(',').map((c) => c.trim()).filter(Boolean).map(q).join(', ');
  const refCols = fk.refColumns.split(',').map((c) => c.trim()).filter(Boolean).map(q).join(', ');
  const name = fk.name.trim() ? `CONSTRAINT ${q(fk.name.trim())} ` : '';
  const del = fk.onDelete.trim() ? ` ON DELETE ${fk.onDelete.trim().toUpperCase()}` : '';
  const upd = fk.onUpdate.trim() ? ` ON UPDATE ${fk.onUpdate.trim().toUpperCase()}` : '';
  return `${name}FOREIGN KEY (${cols}) REFERENCES ${q(fk.refTable.trim())} (${refCols})${del}${upd}`;
};

const fkColumnKeys = (raw: string): string[] =>
  raw.split(',').map((c) => c.trim()).filter(Boolean);

/** Stable diff key for one canonical (bridge) FK row. */
const canonicalFkKey = (fk: { columns: string[]; refTable: string; refColumns: (string | null)[]; onDelete: string | null; onUpdate: string | null }): string =>
  [
    fk.columns.join(','),
    fk.refTable,
    fk.refColumns.map((c) => (c ?? '')).join(','),
    (fk.onDelete ?? 'NO ACTION').toUpperCase(),
    (fk.onUpdate ?? 'NO ACTION').toUpperCase(),
  ].join('|');

/** Stable diff key for one draft FK row. */
const draftFkKey = (fk: DesignerForeignKey): string =>
  [
    fkColumnKeys(fk.columns).join(','),
    fk.refTable.trim(),
    fkColumnKeys(fk.refColumns).join(','),
    (fk.onDelete.trim() || 'NO ACTION').toUpperCase(),
    (fk.onUpdate.trim() || 'NO ACTION').toUpperCase(),
  ].join('|');

/**
 * Shared FK diff walk: add missing constraints, drop removed ones, recreate
 * changed ones (columns / reference / actions). Names are the identity —
 * an unnamed draft FK against a named original counts as a change (drop the
 * original, add the unnamed one).
 */
export const diffForeignKeys = (
  originalFks: OriginalTable['foreignKeys'],
  currentFks: DesignerForeignKey[],
  opts: { addFk: (fk: DesignerForeignKey) => string; dropFk: (name: string) => string },
): string[] => {
  const statements: string[] = [];
  const live = currentFks.filter((fk) => fkColumnKeys(fk.columns).length > 0 && fk.refTable.trim() && fkColumnKeys(fk.refColumns).length > 0);
  const originalByName = new Map(originalFks.map((fk) => [fk.name ?? '', fk]));
  for (const fk of live) {
    const name = fk.name.trim();
    const before = originalByName.get(name);
    if (!before) {
      statements.push(opts.addFk(fk));
    } else if (canonicalFkKey(before) !== draftFkKey(fk)) {
      statements.push(opts.dropFk(before.name ?? name));
      statements.push(opts.addFk(fk));
    }
  }
  for (const before of originalFks) {
    const name = before.name ?? '';
    if (!live.some((fk) => fk.name.trim() === name)) {
      statements.push(opts.dropFk(before.name ?? name));
    }
  }
  return statements;
};

/**
 * ALTER diff vs the prefilled original.
 *
 * Known v1 limitations (documented on purpose — valid syntax for the common
 * add-column / add-index / change-default cases matters more than full diffing):
 * - No column rename detection: a renamed column generates DROP COLUMN + ADD
 *   COLUMN and the data in it is lost.
 * - No type-change data migration (no USING clauses, no charset conversions).
 * - Single-column primary keys only (bridge-reported primaryKey).
 * - PG: removing the PK column together with a new PK in one run fails (the
 *   DROP COLUMN already removed the constraint, DROP CONSTRAINT errors).
 *
 * Reused verbatim for mariadb (getAlterBuilder): mariadb quoting is identical
 * backticks and the type default matches mysql's.
 */
export const buildAlterMysql = (
  table: string,
  original: OriginalTable,
  cols: DesignerColumn[],
  indexes: DesignerIndex[],
  tableRef: string,
  foreignKeys: DesignerForeignKey[] = [],
): string => {
  const q = (id: string) => quoteIdent('mysql', id);
  const alter = (action: string) => `ALTER TABLE ${tableRef} ${action}`;
  const statements: string[] = [];
  const originalByName = new Map(original.columns.map((c) => [c.name, c]));
  const currentNames = new Set(cols.map((c) => c.name.trim()).filter(Boolean));
  const currentPk = cols.find((c) => c.pk && c.name.trim())?.name.trim() ?? null;
  let pkDropped = false;
  const dropPkIfNeeded = () => {
    if (!pkDropped && original.pkColumn) {
      statements.push(alter('DROP PRIMARY KEY'));
      pkDropped = true;
    }
  };
  for (const col of cols) {
    const name = col.name.trim();
    if (!name) continue;
    const before = originalByName.get(name);
    if (!before) {
      statements.push(alter(`ADD COLUMN ${columnDefSql('mysql', col)}`));
    } else if (
      before.type !== col.type.trim()
      || before.nullable !== col.nullable
      || before.defaultValue.trim() !== col.defaultValue.trim()
    ) {
      statements.push(alter(`MODIFY COLUMN ${columnDefSql('mysql', col)}`));
    }
  }
  for (const before of original.columns) {
    if (currentNames.has(before.name)) continue;
    if (before.name === original.pkColumn) dropPkIfNeeded();
    statements.push(alter(`DROP COLUMN ${q(before.name)}`));
  }
  if (currentPk !== original.pkColumn) {
    dropPkIfNeeded();
    if (currentPk) statements.push(alter(`ADD PRIMARY KEY (${q(currentPk)})`));
  }
  statements.push(...diffIndexes(original.indexes, indexes, {
    // mysql places USING after the column list; no partial-index WHERE exists.
    addIndex: ({ name, unique, columns, method }) => {
      const using = effectiveIndexMethod('mysql', method);
      const cols = renderIndexColumns('mysql', columns).join(', ');
      return alter(`ADD ${unique ? 'UNIQUE ' : ''}INDEX ${q(name)} (${cols})${using ? ` USING ${using}` : ''}`);
    },
    dropIndex: (name) => alter(`DROP INDEX ${q(name)}`),
    defaultMethod: DEFAULT_INDEX_METHOD.mysql,
  }));
  statements.push(...diffForeignKeys(original.foreignKeys ?? [], foreignKeys, {
    addFk: (fk) => alter(`ADD ${buildFkConstraintSql('mysql', fk)}`),
    dropFk: (name) => alter(`DROP FOREIGN KEY ${q(name)}`),
  }));
  return statements.length ? statements.join(';\n') + ';' : '';
};

// See buildAlterMysql for the shared v1 limitations; PG splits column
// modification into ALTER COLUMN TYPE / SET NOT NULL / SET DEFAULT clauses.
export const buildAlterPg = (
  table: string,
  original: OriginalTable,
  cols: DesignerColumn[],
  indexes: DesignerIndex[],
  tableRef: string,
  foreignKeys: DesignerForeignKey[] = [],
): string => {
  const q = (id: string) => quoteIdent('postgresql', id);
  const alter = (action: string) => `ALTER TABLE ${tableRef} ${action}`;
  const statements: string[] = [];
  const originalByName = new Map(original.columns.map((c) => [c.name, c]));
  const currentNames = new Set(cols.map((c) => c.name.trim()).filter(Boolean));
  const currentPk = cols.find((c) => c.pk && c.name.trim())?.name.trim() ?? null;
  for (const col of cols) {
    const name = col.name.trim();
    if (!name) continue;
    const before = originalByName.get(name);
    if (!before) {
      statements.push(alter(`ADD COLUMN ${columnDefSql('postgresql', col)}`));
      continue;
    }
    const clauses: string[] = [];
    if (before.type !== col.type.trim()) clauses.push(`TYPE ${columnTypeOrDefault('postgresql', col.type)}`);
    if (before.nullable !== col.nullable) clauses.push(col.nullable ? 'DROP NOT NULL' : 'SET NOT NULL');
    const nextDefault = col.defaultValue.trim();
    if (before.defaultValue.trim() !== nextDefault) {
      clauses.push(nextDefault ? `SET DEFAULT ${nextDefault}` : 'DROP DEFAULT');
    }
    if (clauses.length) {
      statements.push(alter(clauses.map((cl) => `ALTER COLUMN ${q(name)} ${cl}`).join(', ')));
    }
  }
  if (currentPk !== original.pkColumn) {
    if (original.pkConstraintName) statements.push(alter(`DROP CONSTRAINT ${q(original.pkConstraintName)}`));
    if (currentPk) statements.push(alter(`ADD CONSTRAINT ${q(`${table}_pkey`)} PRIMARY KEY (${q(currentPk)})`));
  }
  for (const before of original.columns) {
    if (!currentNames.has(before.name)) statements.push(alter(`DROP COLUMN ${q(before.name)}`));
  }
  statements.push(...diffIndexes(original.indexes, indexes, {
    // pg places USING between the table ref and the column list; a WHERE
    // predicate turns the index into a partial index.
    addIndex: ({ name, unique, columns, method, where }) => {
      const using = effectiveIndexMethod('postgresql', method);
      const cols = renderIndexColumns('postgresql', columns).join(', ');
      const predicate = where.trim() ? ` WHERE ${where.trim()}` : '';
      return `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${q(name)} ON ${tableRef}${using ? ` USING ${using}` : ''} (${cols})${predicate}`;
    },
    dropIndex: (name) => `DROP INDEX ${q(name)}`,
    defaultMethod: DEFAULT_INDEX_METHOD.postgresql,
  }));
  statements.push(...diffForeignKeys(original.foreignKeys ?? [], foreignKeys, {
    addFk: (fk) => `ALTER TABLE ${tableRef} ADD ${buildFkConstraintSql('postgresql', fk)}`,
    dropFk: (name) => `ALTER TABLE ${tableRef} DROP CONSTRAINT ${q(name)}`,
  }));
  return statements.length ? statements.join(';\n') + ';' : '';
};

// T-SQL ALTER walk. ADD/DROP COLUMN and ALTER COLUMN (type + restated
// nullability) are supported; a default-value change on an existing column
// is not (T-SQL ALTER COLUMN refuses to touch columns with default
// constraints) and throws MSSQL_DEFAULT_UNSUPPORTED — the component catches
// it and surfaces the localized message. PK changes go through named
// constraints; index drops need the T-SQL `ON <table>` clause.
export const buildAlterMssql = (
  table: string,
  original: OriginalTable,
  cols: DesignerColumn[],
  indexes: DesignerIndex[],
  tableRef: string,
  foreignKeys: DesignerForeignKey[] = [],
): string => {
  const q = (id: string) => quoteIdent('mssql', id);
  const alter = (action: string) => `ALTER TABLE ${tableRef} ${action}`;
  const statements: string[] = [];
  const originalByName = new Map(original.columns.map((c) => [c.name, c]));
  const currentNames = new Set(cols.map((c) => c.name.trim()).filter(Boolean));
  const currentPk = cols.find((c) => c.pk && c.name.trim())?.name.trim() ?? null;
  let pkDropped = false;
  const dropPkIfNeeded = () => {
    if (!pkDropped && original.pkColumn && original.pkConstraintName) {
      statements.push(alter(`DROP CONSTRAINT ${q(original.pkConstraintName)}`));
      pkDropped = true;
    }
  };
  for (const col of cols) {
    const name = col.name.trim();
    if (!name) continue;
    const before = originalByName.get(name);
    if (!before) {
      statements.push(alter(`ADD ${columnDefSql('mssql', col)}`));
      continue;
    }
    if (before.defaultValue.trim() !== col.defaultValue.trim()) {
      throw new Error('MSSQL_DEFAULT_UNSUPPORTED');
    }
    if (before.type !== col.type.trim() || before.nullable !== col.nullable) {
      // T-SQL ALTER COLUMN restates the column: nullability rides on the type.
      statements.push(alter(`ALTER COLUMN ${q(name)} ${columnTypeOrDefault('mssql', col.type)}${col.nullable ? ' NULL' : ' NOT NULL'}`));
    }
  }
  for (const before of original.columns) {
    if (currentNames.has(before.name)) continue;
    if (before.name === original.pkColumn) dropPkIfNeeded();
    statements.push(alter(`DROP COLUMN ${q(before.name)}`));
  }
  if (currentPk !== original.pkColumn) {
    dropPkIfNeeded();
    if (currentPk) statements.push(alter(`ADD CONSTRAINT ${q(`PK_${table}`)} PRIMARY KEY (${q(currentPk)})`));
  }
  statements.push(...diffIndexes(original.indexes, indexes, {
    // tsql places the method between UNIQUE and INDEX; drops need ON <table>.
    addIndex: ({ name, unique, columns, method, where }) =>
      buildIndexStatement('mssql', { name, unique, columns, method, where, tableRef }),
    dropIndex: (name) => `DROP INDEX ${q(name)} ON ${tableRef}`,
    defaultMethod: DEFAULT_INDEX_METHOD.mssql,
  }));
  statements.push(...diffForeignKeys(original.foreignKeys ?? [], foreignKeys, {
    addFk: (fk) => `ALTER TABLE ${tableRef} ADD ${buildFkConstraintSql('mssql', fk)}`,
    dropFk: (name) => `ALTER TABLE ${tableRef} DROP CONSTRAINT ${q(name)}`,
  }));
  return statements.length ? statements.join(';\n') + ';' : '';
};

// SQLite ALTER walk: only ADD COLUMN / DROP COLUMN / CREATE INDEX / DROP
// INDEX exist (and DROP COLUMN needs SQLite 3.35+, never for PK columns).
// Everything else — column type/nullable/default edits, PK moves, and ADD
// COLUMN NOT NULL without a DEFAULT (rejected outright by SQLite) — throws
// SQLITE_COLUMN_REBUILD_REQUIRED (the component blocks with the localized
// message before any DDL is built).
export const buildAlterSqlite = (
  table: string,
  original: OriginalTable,
  cols: DesignerColumn[],
  indexes: DesignerIndex[],
  tableRef: string,
): string => {
  const q = (id: string) => quoteIdent('sqlite', id);
  const alter = (action: string) => `ALTER TABLE ${tableRef} ${action}`;
  const statements: string[] = [];
  const originalByName = new Map(original.columns.map((c) => [c.name, c]));
  const currentNames = new Set(cols.map((c) => c.name.trim()).filter(Boolean));
  const currentPk = cols.find((c) => c.pk && c.name.trim())?.name.trim() ?? null;
  for (const col of cols) {
    const name = col.name.trim();
    if (!name) continue;
    const before = originalByName.get(name);
    if (!before) {
      // SQLite rejects ADD COLUMN ... NOT NULL without a DEFAULT outright
      // ("Cannot add a NOT NULL column with default value NULL").
      if (!col.nullable && !col.defaultValue.trim()) throw new Error('SQLITE_COLUMN_REBUILD_REQUIRED');
      statements.push(alter(`ADD COLUMN ${columnDefSql('sqlite', col)}`));
      continue;
    }
    if (
      before.type !== col.type.trim()
      || before.nullable !== col.nullable
      || before.defaultValue.trim() !== col.defaultValue.trim()
    ) {
      throw new Error('SQLITE_COLUMN_REBUILD_REQUIRED');
    }
  }
  if (currentPk !== original.pkColumn) throw new Error('SQLITE_COLUMN_REBUILD_REQUIRED');
  for (const before of original.columns) {
    if (currentNames.has(before.name)) continue;
    // SQLite cannot drop a PRIMARY KEY column — that is a rebuild too.
    if (before.name === original.pkColumn) throw new Error('SQLITE_COLUMN_REBUILD_REQUIRED');
    statements.push(alter(`DROP COLUMN ${q(before.name)}`));
  }
  statements.push(...diffIndexes(original.indexes, indexes, {
    // indexMethodStyle 'none': CREATE/DROP INDEX never carry a USING fragment.
    addIndex: ({ name, unique, columns, method, where }) =>
      buildIndexStatement('sqlite', { name, unique, columns, method, where, tableRef }),
    dropIndex: (name) => `DROP INDEX ${q(name)}`,
    defaultMethod: DEFAULT_INDEX_METHOD.sqlite,
  }));
  return statements.length ? statements.join(';\n') + ';' : '';
};

/** Per-engine ALTER dispatcher (mariadb shares the mysql builder). */
export const getAlterBuilder = (engine: SqlEngineId) => {
  if (engine === 'postgresql') return buildAlterPg;
  if (engine === 'mssql') return buildAlterMssql;
  if (engine === 'sqlite') return buildAlterSqlite;
  return buildAlterMysql; // mysql | mariadb
};

/**
 * The ALTER builders are the single authority on unsupported edits: they throw
 * these sentinels before producing any DDL. The component catches them in
 * regenerate() and toasts the mapped i18n key — one rule set, no parallel
 * pre-check that could drift from the builders.
 */
const BLOCKED_SENTINEL_TOASTS: Record<string, string> = {
  SQLITE_COLUMN_REBUILD_REQUIRED: 'db.designer.sqliteColumnRebuild',
  MSSQL_DEFAULT_UNSUPPORTED: 'db.designer.mssqlDefaultUnsupported',
};

// The table reference carries the schema when one is known (pg schemas,
// mysql databases) so the DDL does not depend on the connection search_path.
const buildTableRef = (dialect: Dialect, table: string, schema?: string): string => {
  const q = (id: string) => quoteIdent(dialect, id);
  const t = table.trim();
  return schema?.trim() ? `${q(schema.trim())}.${q(t)}` : q(t);
};

const SqlTableDesigner: React.FC<SqlTableDesignerProps> = ({ connectionId, dialect, schema, editingTable, onClose, onDone }) => {
  const { t } = useI18n();
  const isEdit = !!editingTable;
  const client = databaseClient[dialect];
  const [tableName, setTableName] = useState(editingTable ?? '');
  const [columns, setColumns] = useState<DesignerColumn[]>([emptyColumn()]);
  const [indexes, setIndexes] = useState<DesignerIndex[]>([]);
  const [foreignKeys, setForeignKeys] = useState<DesignerForeignKey[]>([]);
  const [ddlDraft, setDdlDraft] = useState('');
  const [unnamedColumns, setUnnamedColumns] = useState(0);
  const [loading, setLoading] = useState(isEdit);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [executing, setExecuting] = useState(false);
  // Open type-picker menu: fixed-position (anchored to the trigger button's
  // viewport rect) so it escapes the panel's overflow-auto clipping; the
  // invisible backdrop closes it on any outside click.
  const [typeMenu, setTypeMenu] = useState<{ row: number; x: number; y: number } | null>(null);
  // Column picker for an index key-part row (same fixed-position pattern as
  // typeMenu — escapes the panel's overflow clipping; native datalist/multiple
  // are avoided in Electron).
  const [indexColumnMenu, setIndexColumnMenu] = useState<{ idx: number; col: number; x: number; y: number } | null>(null);
  // Reference-table dropdown options: the schema tree's table list (cached
  // single-flight fetch; failures just leave the dropdown empty — the field
  // stays free-text editable through the select's editable fallback).
  const [refTableOptions, setRefTableOptions] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    fetchSqlSchemaTree(dialect, connectionId)
      .then((tree) => {
        if (!alive) return;
        const names = tree.databases
          .filter((db) => !schema || !SQL_ENGINE_BY_ID[dialect].schemaQualified || db.name === schema)
          .flatMap((db) => db.tables);
        setRefTableOptions([...new Set(names)]);
      })
      .catch(() => { /* dropdown stays empty; the field is still usable */ });
    return () => { alive = false; };
  }, [connectionId, dialect, schema]);
  const originalRef = useRef<OriginalTable | null>(null);

  // Prefill from the existing table (edit mode). tableMeta is the single
  // source: columns, indexes, and the bridge-reported primaryKey (constraint
  // name + columns). The PK's own index (mysql `PRIMARY` / pg's named
  // constraint index) is excluded from the editable index list — the PK is a
  // column flag here.
  useEffect(() => {
    if (!editingTable) {
      originalRef.current = null;
      setTableName('');
      setColumns([emptyColumn()]);
      setIndexes([]);
      setForeignKeys([]);
      setDdlDraft('');
      setLoadError(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setLoadError(null);
    setConfirming(false);
    (async () => {
      try {
        const meta = await client.tableMeta({ connectionId, table: editingTable, schema });
        if (!alive) return;
        const loaded: DesignerColumn[] = meta.columns.map((c) => ({
          name: c.name,
          type: c.type,
          nullable: c.nullable,
          defaultValue: c.defaultValue == null ? '' : String(c.defaultValue),
          pk: false,
        }));
        const pkColumn: string | null = meta.primaryKey?.columns[0] ?? meta.columns.find((c) => c.key === 'PRI')?.name ?? null;
        const pkConstraintName: string | null = meta.primaryKey?.name ?? null;
        const editableIndexes: OriginalTable['indexes'] = meta.indexes
          .filter((idx) => idx.name !== 'PRIMARY' && idx.name !== pkConstraintName)
          .map((idx) => ({ name: idx.name, unique: !!idx.unique, columns: idx.columns, method: idx.method ?? null }));
        for (const col of loaded) col.pk = col.name === pkColumn;
        const fkDrafts = (meta.foreignKeys ?? []).map((fk) => ({
          name: fk.name ?? '',
          columns: fk.columns.join(', '),
          refTable: fk.refTable,
          refColumns: fk.refColumns.join(', '),
          onDelete: fk.onDelete && fk.onDelete !== 'NO ACTION' ? fk.onDelete : '',
          onUpdate: fk.onUpdate && fk.onUpdate !== 'NO ACTION' ? fk.onUpdate : '',
        }));
        setForeignKeys(fkDrafts);
        const original: OriginalTable = { columns: loaded, indexes: editableIndexes, foreignKeys: meta.foreignKeys ?? [], pkColumn, pkConstraintName };
        originalRef.current = original;
        setTableName(editingTable);
        setColumns(loaded.map((c) => ({ ...c })));
        // Bridge-reported column names map straight into entries — desc/nulls
        // /where are designer-only edits and start empty on loaded indexes.
        const indexDrafts = editableIndexes.map((i) => ({
          name: i.name,
          unique: !!i.unique,
          columns: i.columns.map((expr) => ({ expr })),
          method: normalizeIndexMethod(dialect, i.method),
          where: i.where ?? '',
          open: true,
        }));
        setIndexes(indexDrafts);
        const tableRef = buildTableRef(dialect, editingTable, schema);
        setDdlDraft(getAlterBuilder(dialect)(editingTable, original, loaded, indexDrafts, tableRef));
      } catch (err) {
        if (alive) setLoadError(dbErrorMessage(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [connectionId, client, editingTable, schema, dialect]);

  // The DDL preview is NOT regenerated on every keystroke (spec): it starts
  // empty in create mode (an empty form generates nothing) and after prefill
  // in edit mode; [regenerate] and the initial prefill both call this.
  const regenerate = () => {
    const table = tableName.trim() || editingTable || '';
    const original = originalRef.current;
    const tableRef = buildTableRef(dialect, table, schema);
    let next = '';
    if (isEdit && original) {
      // SQLite cannot ALTER FKs: block before building (same toast pattern as
      // column rebuilds). The CREATE builder inlines them for new tables.
      if (dialect === 'sqlite') {
        const fkDiff = diffForeignKeys(original.foreignKeys ?? [], foreignKeys, { addFk: () => '', dropFk: () => '' });
        if (fkDiff.length > 0) {
          toast.error(t('db.designer.sqliteColumnRebuild'));
          return;
        }
      }
      // Unsupported edits (sqlite column rebuilds, mssql default edits) throw
      // out of the builder before any DDL exists — map the sentinel to its
      // toast and leave the DDL draft untouched. Unmapped errors propagate.
      try {
        next = getAlterBuilder(dialect)(table, original, columns, indexes, tableRef, foreignKeys);
      } catch (err) {
        const toastKey = err instanceof Error ? BLOCKED_SENTINEL_TOASTS[err.message] : undefined;
        if (!toastKey) throw err;
        toast.error(t(toastKey));
        return;
      }
    } else if (!isEdit) {
      next = buildCreateTable(dialect, table, columns, indexes, tableRef, foreignKeys);
    }
    setDdlDraft(next);
    setConfirming(false);
    // Nameless columns are silently dropped by the DDL builders — surface how
    // many were skipped so an accidental empty row can't shrink the table.
    const skipped = columns.filter((c) => !c.name.trim() && (c.type.trim() || c.defaultValue.trim() || c.pk)).length;
    setUnnamedColumns(skipped);
  };

  const execute = async () => {
    if (executing || loading || !ddlDraft.trim()) return;
    // Inline two-step confirm instead of a dialog: the first click arms the
    // button, the second actually runs the previewed DDL.
    if (!confirming) { setConfirming(true); return; }
    setExecuting(true);
    setConfirming(false);
    try {
      await client.query({ connectionId, sql: ddlDraft });
      toast.success(t('db.grid.applied', { count: ddlDraft.split(';').filter((s) => s.trim()).length }));
      onDone();
    } catch (err) {
      const message = dbErrorMessage(err);
      toast.error(message, t('db.designer.execute'));
    } finally {
      setExecuting(false);
    }
  };

  const setColumn = (index: number, patch: Partial<DesignerColumn>) => {
    setColumns((prev) => prev.map((col, i) => {
      if (i !== index) return patch.pk ? { ...col, pk: false } : col;
      return { ...col, ...patch };
    }));
  };

  const setIndex = (index: number, patch: Partial<DesignerIndex>) => {
    setIndexes((prev) => prev.map((idx, i) => (i === index ? { ...idx, ...patch } : idx)));
  };

  // DBeaver-style Columns grid: one selected key-part row is the target of the
  // toolbar (add/move/delete) — per-row action icons are not used. Selection
  // is clamped at render time, so deletions never leave a dangling target.
  const [selectedKeyPart, setSelectedKeyPart] = useState<{ idx: number; col: number } | null>(null);

  // Column sub-row editing (entry order = key order; move clamps to bounds).
  const setIndexColumn = (idxI: number, colI: number, patch: Partial<IndexColumnEntry>) => {
    setIndexes((prev) => prev.map((idx, i) => (
      i === idxI ? { ...idx, columns: idx.columns.map((c, j) => (j === colI ? { ...c, ...patch } : c)) } : idx
    )));
  };
  const insertIndexColumn = (idxI: number, at: number) => {
    setIndexes((prev) => prev.map((idx, i) => {
      if (i !== idxI) return idx;
      const cols = [...idx.columns];
      cols.splice(Math.max(0, Math.min(cols.length, at)), 0, { expr: '' });
      return { ...idx, columns: cols };
    }));
  };
  const removeIndexColumn = (idxI: number, colI: number) => {
    setIndexes((prev) => prev.map((idx, i) => (
      i === idxI ? { ...idx, columns: idx.columns.filter((_, j) => j !== colI) } : idx
    )));
  };
  const moveIndexColumn = (idxI: number, from: number, to: number) => {
    setIndexes((prev) => prev.map((idx, i) => {
      if (i !== idxI) return idx;
      const cols = [...idx.columns];
      const [moved] = cols.splice(from, 1);
      cols.splice(Math.max(0, Math.min(cols.length, to)), 0, moved);
      return { ...idx, columns: cols };
    }));
  };

  // Foreign-key drafts (single-row editor: comma-separated column pairs).
  const emptyFk = (): DesignerForeignKey => ({ name: '', columns: '', refTable: '', refColumns: '', onDelete: '', onUpdate: '' });
  const setFk = (index: number, patch: Partial<DesignerForeignKey>) => {
    setForeignKeys((prev) => prev.map((fk, i) => (i === index ? { ...fk, ...patch } : fk)));
  };
  const removeForeignKey = (index: number) => setForeignKeys((prev) => prev.filter((_, i) => i !== index));

  const executeDisabled = executing || loading || !ddlDraft.trim() || (!isEdit && !tableName.trim());
  const headerLabel = isEdit ? t('db.designer.edit') : t('db.designer.newTable');

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2 border-b border-border/60 flex items-center gap-2 shrink-0 app-no-drag">
        <span className="text-sm font-medium">{headerLabel}</span>
        {isEdit && (
          <span className="text-xs text-muted-foreground font-mono truncate">
            {schema ? `${schema}.${editingTable}` : editingTable}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button type="button" className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-foreground/5"
            title={t('db.action.close')} onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </div>
      {loadError && <p className="text-destructive text-xs px-3 py-2">{loadError}</p>}
      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-4 text-xs">
        <div className="flex items-center gap-2">
          <label className="w-20 shrink-0 text-muted-foreground" htmlFor="nc-designer-table-name">{t('db.form.label')}</label>
          <Input id="nc-designer-table-name" className="h-7 max-w-[280px] font-mono" value={tableName}
            disabled={isEdit || loading} autoComplete="off" spellCheck={false}
            onChange={(e) => setTableName(e.target.value)} />
        </div>
        <div>
          <div className="flex items-center gap-2 pb-1">
            <span className="font-medium text-foreground/80">{t('db.designer.columnsSection')}</span>
            <Button variant="outline" size="sm" className="h-7" disabled={loading}
              onClick={() => setColumns((prev) => [...prev, emptyColumn()])}>
              <Plus size={12} className="mr-1" />{t('db.designer.addColumn')}
            </Button>
          </div>
          <div className="grid grid-cols-[minmax(110px,1.2fr)_minmax(110px,1.2fr)_56px_minmax(90px,1fr)_40px_28px] gap-1 items-center text-muted-foreground">
            <span>{t('db.grid.filter.column')}</span>
            <span>{t('db.workbench.keyMeta.type')}</span>
            <span>{t('db.workbench.keyMeta.nullable')}</span>
            <span>{t('db.workbench.keyMeta.default')}</span>
            <span className="text-center" title="PK">{t('db.workbench.keyMeta.key')}</span>
            <span />
          </div>
          {columns.map((col, i) => (
            <div key={`col-${i}`} className="grid grid-cols-[minmax(110px,1.2fr)_minmax(110px,1.2fr)_56px_minmax(90px,1fr)_40px_28px] gap-1 items-center pb-1">
              <Input className="h-7 font-mono" value={col.name} disabled={loading} autoComplete="off" spellCheck={false}
                onChange={(e) => setColumn(i, { name: e.target.value })} />
              <div className="relative">
                <Input className="h-7 font-mono pr-6" value={col.type} disabled={loading} autoComplete="off" spellCheck={false}
                  onChange={(e) => setColumn(i, { type: e.target.value })} />
                <button type="button"
                  className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground hover:text-foreground disabled:opacity-40"
                  aria-label={t('db.designer.pickType')} title={t('db.designer.pickType')} disabled={loading}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setTypeMenu((prev) => (prev?.row === i ? null : {
                      // Clamp to the viewport (menu is w-44 / ~224px tall).
                      row: i,
                      x: Math.min(r.left, window.innerWidth - 190),
                      y: Math.min(r.bottom + 2, window.innerHeight - 240),
                    }));
                  }}>
                  <ChevronDown size={12} />
                </button>
              </div>
              <input type="checkbox" className="mx-auto" checked={col.nullable} disabled={loading}
                aria-label={t('db.workbench.keyMeta.nullable')}
                onChange={(e) => setColumn(i, { nullable: e.target.checked })} />
              <Input className="h-7 font-mono" value={col.defaultValue} disabled={loading} autoComplete="off" spellCheck={false}
                onChange={(e) => setColumn(i, { defaultValue: e.target.value })} />
              {/* Single-column PK (v1): the radio moves the flag; it cannot be
                  unset by re-clicking (use another column or edit mode). */}
              <input type="radio" name="nc-designer-pk" className="mx-auto" checked={col.pk} disabled={loading}
                aria-label={t('db.workbench.keyMeta.key')}
                onChange={() => setColumn(i, { pk: true })} />
              <button type="button" className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-foreground/5 disabled:opacity-40"
                title={t('db.action.delete')} disabled={loading || columns.length <= 1}
                onClick={() => setColumns((prev) => prev.filter((_, j) => j !== i))}>
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <div>
          <div className="flex items-center gap-2 pb-1">
            <span className="font-medium text-foreground/80">{t('db.workbench.section.indexes')}</span>
            <Button variant="outline" size="sm" className="h-7" disabled={loading}
              onClick={() => setIndexes((prev) => [...prev, {
                name: '', unique: false, columns: [{ expr: '' }], method: DEFAULT_INDEX_METHOD[dialect], where: '', open: true,
              }])}>
              <Plus size={12} className="mr-1" />{t('db.designer.addIndex')}
            </Button>
          </div>
          {indexes.length > 0 && (
            <div className="grid grid-cols-[16px_minmax(90px,1fr)_48px_minmax(72px,88px)_minmax(60px,1fr)_24px] gap-1 items-center pb-0.5 border-b border-border/60">
              <span />
              <span className="text-[11px] text-muted-foreground">{t('db.designer.indexColumnName')}</span>
              <span className="text-[11px] text-muted-foreground">{t('db.workbench.keyMeta.unique')}</span>
              {INDEX_METHODS[dialect].length > 0 && (
                <span className="text-[11px] text-muted-foreground">{t('db.designer.indexMethod')}</span>
              )}
              <span className="text-[11px] text-muted-foreground">{t('db.designer.indexKeyColumn')}</span>
              <span />
            </div>
          )}
          {indexes.map((idx, i) => {
            const namedCols = idx.columns.filter((c) => c.expr.trim());
            return (
              <div key={`idx-${i}`} className="pb-1">
                {/* Header row: name / unique / method / column summary / expand / delete */}
                <div className="grid grid-cols-[16px_minmax(90px,1fr)_48px_minmax(72px,88px)_minmax(60px,1fr)_24px] gap-1 items-center">
                  <button type="button"
                    className="p-0.5 rounded text-muted-foreground hover:text-foreground disabled:opacity-50"
                    disabled={loading}
                    aria-label={t(idx.open ? 'db.designer.indexCollapse' : 'db.designer.indexExpand')}
                    title={t(idx.open ? 'db.designer.indexCollapse' : 'db.designer.indexExpand')}
                    onClick={() => setIndex(i, { open: !idx.open })}>
                    {idx.open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </button>
                  <Input className="h-7 font-mono" value={idx.name} disabled={loading} autoComplete="off" spellCheck={false}
                    onChange={(e) => setIndex(i, { name: e.target.value })} />
                  <label className="flex items-center gap-1 text-muted-foreground">
                    <input type="checkbox" checked={idx.unique} disabled={loading}
                      onChange={(e) => setIndex(i, { unique: e.target.checked })} />
                    {t('db.workbench.keyMeta.unique')}
                  </label>
                  {INDEX_METHODS[dialect].length > 0 && (
                    <select
                      className="h-7 min-w-0 rounded border border-border bg-background px-1 text-xs disabled:opacity-50"
                      aria-label={t('db.designer.indexMethod')} title={t('db.designer.indexMethod')}
                      value={idx.method} disabled={loading}
                      onChange={(e) => setIndex(i, { method: e.target.value })}>
                      {INDEX_METHODS[dialect].map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  )}
                  <span className="text-[11px] text-muted-foreground truncate font-mono" title={namedCols.map((c) => c.expr.trim()).join(', ')}>
                    {namedCols.map((c) => c.expr.trim()).join(', ')}
                  </span>
                  <button type="button" className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-foreground/5"
                    title={t('db.action.delete')}
                    onClick={() => setIndexes((prev) => prev.filter((_, j) => j !== i))}>
                    <X size={12} />
                  </button>
                </div>
                {/* Key-part editor — strict DBeaver Columns-tab layout: titled
                    grid (# / key column / sort / nulls), toolbar add/move/
                    delete acting on the selected row, WHERE predicate group. */}
                {idx.open && (() => {
                  const hasNulls = SQL_ENGINE_BY_ID[dialect].features.indexNulls;
                  const gridCols = hasNulls
                    ? 'grid-cols-[18px_minmax(0,1fr)_64px_92px]'
                    : 'grid-cols-[18px_minmax(0,1fr)_64px]';
                  const sel = selectedKeyPart && selectedKeyPart.idx === i && idx.columns[selectedKeyPart.col]
                    ? selectedKeyPart
                    : null;
                  return (
                    <div className="pl-[16px] pt-0.5">
                      {/* header: grid titles left, row toolbar right */}
                      <div className="flex items-center gap-1 pb-0.5">
                        <div className={`grid flex-1 min-w-0 gap-1 ${gridCols}`}>
                          <span className="text-[11px] text-muted-foreground leading-4">#</span>
                          <span className="text-[11px] text-muted-foreground leading-4">{t('db.designer.indexKeyColumn')}</span>
                          <span className="text-[11px] text-muted-foreground leading-4">{t('db.designer.indexSort')}</span>
                          {hasNulls && <span className="text-[11px] text-muted-foreground leading-4">{t('db.designer.indexNulls')}</span>}
                        </div>
                        <div className="flex items-center gap-0.5 shrink-0">
                          <button type="button"
                            className="p-1 rounded border border-input text-muted-foreground hover:text-foreground hover:bg-foreground/5 disabled:opacity-40"
                            disabled={loading}
                            aria-label={t('db.designer.addIndexColumn')} title={t('db.designer.addIndexColumn')}
                            onClick={() => {
                              const at = sel ? sel.col + 1 : idx.columns.length;
                              insertIndexColumn(i, at);
                              setSelectedKeyPart({ idx: i, col: at });
                            }}>
                            <Plus size={11} />
                          </button>
                          <button type="button"
                            className="p-1 rounded border border-input text-muted-foreground hover:text-foreground hover:bg-foreground/5 disabled:opacity-40"
                            disabled={loading || !sel || sel.col === 0}
                            aria-label={t('db.designer.indexMoveUp')} title={t('db.designer.indexMoveUp')}
                            onClick={() => {
                              if (!sel) return;
                              moveIndexColumn(i, sel.col, sel.col - 1);
                              setSelectedKeyPart({ idx: i, col: sel.col - 1 });
                            }}>
                            <ArrowUp size={11} />
                          </button>
                          <button type="button"
                            className="p-1 rounded border border-input text-muted-foreground hover:text-foreground hover:bg-foreground/5 disabled:opacity-40"
                            disabled={loading || !sel || sel.col >= idx.columns.length - 1}
                            aria-label={t('db.designer.indexMoveDown')} title={t('db.designer.indexMoveDown')}
                            onClick={() => {
                              if (!sel) return;
                              moveIndexColumn(i, sel.col, sel.col + 1);
                              setSelectedKeyPart({ idx: i, col: sel.col + 1 });
                            }}>
                            <ArrowDown size={11} />
                          </button>
                          <button type="button"
                            className="p-1 rounded border border-input text-muted-foreground hover:text-destructive hover:bg-foreground/5 disabled:opacity-40"
                            disabled={loading || !sel}
                            aria-label={t('db.action.delete')} title={t('db.action.delete')}
                            onClick={() => {
                              if (!sel) return;
                              removeIndexColumn(i, sel.col);
                              setSelectedKeyPart(null);
                            }}>
                            <X size={11} />
                          </button>
                        </div>
                      </div>
                      {/* key-part rows: click to select (toolbar target) */}
                      <div className="space-y-0.5">
                        {idx.columns.map((entry, j) => (
                          <div key={`idxc-${i}-${j}`}
                            className={`grid gap-1 items-center rounded px-0.5 -mx-0.5 py-px cursor-pointer ${gridCols} ${sel?.col === j ? 'bg-foreground/5' : 'hover:bg-foreground/[0.03]'}`}
                            onMouseDown={() => setSelectedKeyPart({ idx: i, col: j })}>
                            <span className="text-[11px] text-muted-foreground text-right leading-4 pr-0.5">{j + 1}</span>
                            <div className="relative min-w-0">
                              <Input className="h-6 font-mono pr-6 text-xs" value={entry.expr} disabled={loading} autoComplete="off" spellCheck={false}
                                placeholder={t('db.designer.indexKeyPart')}
                                title={SQL_ENGINE_BY_ID[dialect].features.indexNulls ? t('db.designer.indexExprHint') : undefined}
                                onChange={(e) => setIndexColumn(i, j, { expr: e.target.value })} />
                              <button type="button"
                                className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground hover:text-foreground disabled:opacity-50"
                                disabled={loading}
                                aria-label={t('db.designer.indexColumnPicker')} title={t('db.designer.indexColumnPicker')}
                                onClick={(ev) => setIndexColumnMenu({ idx: i, col: j, x: ev.clientX, y: ev.clientY })}>
                                <ChevronDown size={12} />
                              </button>
                            </div>
                            <select
                              className="h-6 min-w-0 rounded border border-border bg-background px-1 text-xs disabled:opacity-50"
                              aria-label={t('db.designer.indexSort')} title={t('db.designer.indexSort')}
                              value={entry.desc ? 'DESC' : 'ASC'} disabled={loading}
                              onChange={(e) => setIndexColumn(i, j, { desc: e.target.value === 'DESC' })}>
                              <option value="ASC">ASC</option>
                              <option value="DESC">DESC</option>
                            </select>
                            {hasNulls && (
                              <select
                                className="h-6 min-w-0 rounded border border-border bg-background px-1 text-xs disabled:opacity-50"
                                aria-label={t('db.designer.indexNulls')} title={t('db.designer.indexNulls')}
                                value={entry.nulls ?? ''} disabled={loading}
                                onChange={(e) => setIndexColumn(i, j, { nulls: e.target.value === '' ? undefined : e.target.value as 'first' | 'last' })}>
                                <option value="">{t('db.designer.indexNullsDefault')}</option>
                                <option value="first">NULLS FIRST</option>
                                <option value="last">NULLS LAST</option>
                              </select>
                            )}
                          </div>
                        ))}
                      </div>
                      {/* partial/filtered predicate group (DBeaver "Where" field) */}
                      {SQL_ENGINE_BY_ID[dialect].features.indexWhere && (
                        <div className="flex items-center gap-2 pt-1">
                          <span className="text-[11px] text-muted-foreground shrink-0 font-mono">WHERE</span>
                          <Input className="h-6 flex-1 min-w-0 font-mono text-xs" value={idx.where} disabled={loading} autoComplete="off" spellCheck={false}
                            placeholder={t('db.designer.indexWhere')} title={t('db.designer.indexWhere')}
                            onChange={(e) => setIndex(i, { where: e.target.value })} />
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
        <div>
          <div className="flex items-center gap-2 pb-1">
            <span className="font-medium text-foreground/80">{t('db.designer.foreignKeys')}</span>
            <Button variant="outline" size="sm" className="h-7" disabled={loading || dialect === 'sqlite'}
              title={dialect === 'sqlite' ? t('db.designer.fkSqliteHint') : undefined}
              onClick={() => setForeignKeys((prev) => [...prev, emptyFk()])}>
              <Plus size={12} className="mr-1" />{t('db.designer.addForeignKey')}
            </Button>
          </div>
          {foreignKeys.length > 0 && (
            <div className="grid grid-cols-[minmax(90px,1fr)_minmax(90px,1fr)_minmax(110px,1.1fr)_minmax(90px,1fr)_88px_88px_24px] gap-1 items-center pb-0.5 border-b border-border/60">
              <span className="text-[11px] text-muted-foreground">{t('db.designer.fkName')}</span>
              <span className="text-[11px] text-muted-foreground">{t('db.designer.fkColumns')}</span>
              <span className="text-[11px] text-muted-foreground">{t('db.designer.fkRefTable')}</span>
              <span className="text-[11px] text-muted-foreground">{t('db.designer.fkRefColumns')}</span>
              <span className="text-[11px] text-muted-foreground">{t('db.designer.fkOnDelete')}</span>
              <span className="text-[11px] text-muted-foreground">{t('db.designer.fkOnUpdate')}</span>
              <span />
            </div>
          )}
          {foreignKeys.map((fk, i) => (
            <div key={`fk-${i}`} className="grid grid-cols-[minmax(90px,1fr)_minmax(90px,1fr)_minmax(110px,1.1fr)_minmax(90px,1fr)_88px_88px_24px] gap-1 items-center pb-1">
              <Input className="h-7 font-mono" value={fk.name} disabled={loading} autoComplete="off" spellCheck={false}
                onChange={(e) => setFk(i, { name: e.target.value })} />
              <Input className="h-7 font-mono" value={fk.columns} disabled={loading} autoComplete="off" spellCheck={false}
                placeholder={t('db.designer.fkColumns')} title={t('db.designer.fkColumnsHint')}
                onChange={(e) => setFk(i, { columns: e.target.value })} />
              <select
                className="h-7 min-w-0 rounded border border-border bg-background px-1 text-xs disabled:opacity-50"
                aria-label={t('db.designer.fkRefTable')} title={t('db.designer.fkRefTable')}
                value={fk.refTable} disabled={loading}
                onChange={(e) => setFk(i, { refTable: e.target.value })}>
                <option value="">{t('db.designer.fkRefTable')}</option>
                {refTableOptions.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
              <Input className="h-7 font-mono" value={fk.refColumns} disabled={loading} autoComplete="off" spellCheck={false}
                placeholder={t('db.designer.fkRefColumns')} title={t('db.designer.fkColumnsHint')}
                onChange={(e) => setFk(i, { refColumns: e.target.value })} />
              <select className="h-7 min-w-0 rounded border border-border bg-background px-1 text-xs disabled:opacity-50"
                aria-label={t('db.designer.fkOnDelete')} title={t('db.designer.fkOnDelete')}
                value={fk.onDelete} disabled={loading}
                onChange={(e) => setFk(i, { onDelete: e.target.value })}>
                <option value="">{t('db.designer.fkActionDefault')}</option>
                {FK_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              <select className="h-7 min-w-0 rounded border border-border bg-background px-1 text-xs disabled:opacity-50"
                aria-label={t('db.designer.fkOnUpdate')} title={t('db.designer.fkOnUpdate')}
                value={fk.onUpdate} disabled={loading}
                onChange={(e) => setFk(i, { onUpdate: e.target.value })}>
                <option value="">{t('db.designer.fkActionDefault')}</option>
                {FK_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              <button type="button" className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-foreground/5"
                title={t('db.action.delete')}
                onClick={() => removeForeignKey(i)}>
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <div className="flex flex-col min-h-[180px]">
          <span className="block pb-1 font-medium text-foreground/80">{t('db.structure.definition')}</span>
          <textarea
            className="flex-1 min-h-[150px] w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs focus-visible:outline-none"
            value={ddlDraft}
            spellCheck={false}
            placeholder={t('db.designer.ddlHint')}
            onChange={(e) => { setDdlDraft(e.target.value); setConfirming(false); }}
          />
        </div>
      </div>
      <div className="px-3 py-2 border-t border-border/60 flex items-center gap-2 shrink-0 app-no-drag">
        {confirming
          ? <span className="text-xs text-amber-500">{t('db.designer.confirmExecute')}</span>
          : !ddlDraft.trim() && <span className="text-xs text-muted-foreground">{t('db.designer.ddlHint')}</span>}
        {unnamedColumns > 0 && (
          <span className="text-xs text-amber-500">{t('db.designer.unnamedColumns', { count: unnamedColumns })}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-8 px-3" disabled={loading} onClick={regenerate}>
            <RotateCcw size={12} className="mr-1" />{t('db.designer.regenerate')}
          </Button>
          <Button variant={confirming ? 'destructive' : 'default'} size="sm" className="h-8 px-4 font-medium" disabled={executeDisabled}
            title={confirming ? t('db.designer.confirmExecute') : t('db.designer.execute')}
            onClick={() => void execute()}>
            {confirming ? <Check size={13} className="mr-1" /> : <Play size={13} className="mr-1" />}
            {confirming ? t('db.designer.confirmExecute') : t('db.designer.execute')}
          </Button>
        </div>
      </div>
      {typeMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setTypeMenu(null)} />
          <div className="fixed z-50 w-44 max-h-56 overflow-auto rounded-md border border-border bg-popover text-popover-foreground shadow-lg py-1 text-xs app-no-drag"
            style={{ left: typeMenu.x, top: typeMenu.y }}>
            {COLUMN_TYPES[dialect].map((type) => (
              <button key={type} type="button"
                className="block w-full text-left px-2 py-1 font-mono hover:bg-foreground/10"
                onClick={() => { setColumn(typeMenu.row, { type }); setTypeMenu(null); }}>
                {type}
              </button>
            ))}
          </div>
        </>
      )}
      {indexColumnMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIndexColumnMenu(null)} />
          <div className="fixed z-50 w-48 max-h-56 overflow-auto rounded-md border border-border bg-popover text-popover-foreground shadow-lg py-1 text-xs app-no-drag"
            style={{ left: indexColumnMenu.x, top: indexColumnMenu.y }}>
            {columns.filter((c) => c.name.trim()).map((c) => (
              <button key={c.name} type="button"
                className="block w-full text-left px-2 py-1 font-mono hover:bg-foreground/10"
                onClick={() => {
                  setIndexColumn(indexColumnMenu.idx, indexColumnMenu.col, { expr: c.name.trim() });
                  setIndexColumnMenu(null);
                }}>
                {c.name}
              </button>
            ))}
            {columns.every((c) => !c.name.trim()) && (
              <span className="block px-2 py-1 text-muted-foreground">{t('db.designer.indexColumnEmpty')}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default SqlTableDesigner;
