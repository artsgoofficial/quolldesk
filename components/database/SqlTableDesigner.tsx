import { Check, ChevronDown, Play, Plus, RotateCcw, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
// The @/ alias is the repo's sanctioned path for component-layer imports of
// infrastructure services (relative ../../infrastructure imports are eslint-restricted).
import { databaseClient, dbErrorMessage } from '@/infrastructure/services/databaseClient';
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

/** Editable index row — columns stay comma-separated text until DDL build. */
interface DesignerIndex {
  name: string;
  unique: boolean;
  columns: string;
  /** Access method (USING clause); empty string = dialect default. */
  method: string;
}

/** Prefilled snapshot of the existing table used as the ALTER diff base. */
interface OriginalTable {
  columns: DesignerColumn[];
  indexes: { name: string; unique: boolean; columns: string[]; method?: string | null }[];
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

const parseIndexColumns = (raw: string): string[] =>
  raw.split(',').map((s) => s.trim()).filter(Boolean);

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
  opts: { unique: boolean; name: string; tableRef: string; columns: string[]; method: string },
): string => {
  const q = (id: string) => quoteIdent(dialect, id);
  const style = SQL_ENGINE_BY_ID[dialect].indexMethodStyle;
  const using = style === 'none' ? '' : effectiveIndexMethod(dialect, opts.method);
  const cols = opts.columns.map(q).join(', ');
  const uniquePrefix = opts.unique ? 'UNIQUE ' : '';
  if (style === 'tsql') {
    return `CREATE ${uniquePrefix}${using ? `${using} ` : ''}INDEX ${q(opts.name)} ON ${opts.tableRef} (${cols})`;
  }
  if (style === 'pg') {
    return `CREATE ${uniquePrefix}INDEX ${q(opts.name)} ON ${opts.tableRef}${using ? ` USING ${using}` : ''} (${cols})`;
  }
  return `CREATE ${uniquePrefix}INDEX ${q(opts.name)} ON ${opts.tableRef} (${cols})${using ? ` USING ${using}` : ''}`;
};

export const buildCreateTable = (
  dialect: Dialect,
  table: string,
  cols: DesignerColumn[],
  indexes: DesignerIndex[],
  tableRef: string,
): string => {
  const q = (id: string) => quoteIdent(dialect, id);
  const named = cols.filter((c) => c.name.trim());
  if (!table.trim() || named.length === 0) return '';
  const lines = named.map((c) => `  ${columnDefSql(dialect, c)}`);
  const pk = named.find((c) => c.pk);
  if (pk) lines.push(`  PRIMARY KEY (${q(pk.name.trim())})`);
  const statements = [`CREATE TABLE ${tableRef} (\n${lines.join(',\n')}\n)`];
  for (const idx of indexes) {
    const idxCols = parseIndexColumns(idx.columns);
    if (!idx.name.trim() || idxCols.length === 0) continue;
    statements.push(buildIndexStatement(dialect, {
      unique: idx.unique,
      name: idx.name.trim(),
      tableRef,
      columns: idxCols,
      method: idx.method,
    }));
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
    addIndex: (idx: { name: string; unique: boolean; columns: string[]; method: string }) => string;
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
  const liveIndexes = currentIndexes.filter((i) => i.name.trim() && parseIndexColumns(i.columns).length > 0);
  const originalByName = new Map(originalIndexes.map((i) => [i.name, i]));
  for (const idx of liveIndexes) {
    const name = idx.name.trim();
    const before = originalByName.get(name);
    const nextCols = parseIndexColumns(idx.columns);
    if (!before) {
      statements.push(opts.addIndex({ name, unique: idx.unique, columns: nextCols, method: idx.method }));
    } else if (
      (before.unique ?? false) !== idx.unique
      || before.columns.join(',') !== nextCols.join(',')
      || methodKey(before.method) !== methodKey(idx.method)
    ) {
      statements.push(opts.dropIndex(name));
      statements.push(opts.addIndex({ name, unique: idx.unique, columns: nextCols, method: idx.method }));
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
    // mysql places USING after the column list.
    addIndex: ({ name, unique, columns, method }) => {
      const using = effectiveIndexMethod('mysql', method);
      return alter(`ADD ${unique ? 'UNIQUE ' : ''}INDEX ${q(name)} (${columns.map(q).join(', ')})${using ? ` USING ${using}` : ''}`);
    },
    dropIndex: (name) => alter(`DROP INDEX ${q(name)}`),
    defaultMethod: DEFAULT_INDEX_METHOD.mysql,
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
    // pg places USING between the table ref and the column list.
    addIndex: ({ name, unique, columns, method }) => {
      const using = effectiveIndexMethod('postgresql', method);
      return `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${q(name)} ON ${tableRef}${using ? ` USING ${using}` : ''} (${columns.map(q).join(', ')})`;
    },
    dropIndex: (name) => `DROP INDEX ${q(name)}`,
    defaultMethod: DEFAULT_INDEX_METHOD.postgresql,
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
    addIndex: ({ name, unique, columns, method }) =>
      buildIndexStatement('mssql', { name, unique, columns, method, tableRef }),
    dropIndex: (name) => `DROP INDEX ${q(name)} ON ${tableRef}`,
    defaultMethod: DEFAULT_INDEX_METHOD.mssql,
  }));
  return statements.length ? statements.join(';\n') + ';' : '';
};

// SQLite ALTER walk: only ADD COLUMN / DROP COLUMN / CREATE INDEX / DROP
// INDEX exist (and DROP COLUMN needs SQLite 3.35+, never for PK columns).
// Everything else — column type/nullable/default edits, PK moves — requires
// a table rebuild and throws SQLITE_COLUMN_REBUILD_REQUIRED (the component
// blocks with the localized message before any DDL is built).
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
    addIndex: ({ name, unique, columns, method }) =>
      buildIndexStatement('sqlite', { name, unique, columns, method, tableRef }),
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
 * Blocking unsupported edits BEFORE any DDL is built: sqlite column edits /
 * PK moves need a rebuild, mssql default edits are unsupported in v1. The
 * returned value is an i18n key (db.designer.*) — the component toasts it and
 * skips regeneration. Supported engines (mysql family, pg) never block.
 */
export const designerBlockedReason = (
  engine: SqlEngineId,
  original: OriginalTable,
  cols: DesignerColumn[],
): string | null => {
  const originalByName = new Map(original.columns.map((c) => [c.name, c]));
  const currentNames = new Set(cols.map((c) => c.name.trim()).filter(Boolean));
  const currentPk = cols.find((c) => c.pk && c.name.trim())?.name.trim() ?? null;
  if (engine === 'sqlite') {
    for (const col of cols) {
      const name = col.name.trim();
      if (!name) continue;
      const before = originalByName.get(name);
      if (
        before
        && (before.type !== col.type.trim()
          || before.nullable !== col.nullable
          || before.defaultValue.trim() !== col.defaultValue.trim())
      ) {
        return 'db.designer.sqliteColumnRebuild';
      }
    }
    if (currentPk !== original.pkColumn) return 'db.designer.sqliteColumnRebuild';
    if (original.pkColumn && !currentNames.has(original.pkColumn)) return 'db.designer.sqliteColumnRebuild';
    return null;
  }
  if (engine === 'mssql') {
    for (const col of cols) {
      const name = col.name.trim();
      if (!name) continue;
      const before = originalByName.get(name);
      if (before && before.defaultValue.trim() !== col.defaultValue.trim()) {
        return 'db.designer.mssqlDefaultUnsupported';
      }
    }
    return null;
  }
  return null;
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
        const original: OriginalTable = { columns: loaded, indexes: editableIndexes, pkColumn, pkConstraintName };
        originalRef.current = original;
        setTableName(editingTable);
        setColumns(loaded.map((c) => ({ ...c })));
        const indexDrafts = editableIndexes.map((i) => ({
          name: i.name,
          unique: !!i.unique,
          columns: i.columns.join(', '),
          method: normalizeIndexMethod(dialect, i.method),
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
    // Unsupported diffs (sqlite column rebuilds, mssql default edits) are
    // blocked BEFORE the builder runs — the builders throw the same condition
    // but a toast beats a stack trace, and the DDL stays untouched.
    if (isEdit && original) {
      const blocked = designerBlockedReason(dialect, original, columns);
      if (blocked) {
        toast.error(t(blocked));
        return;
      }
    }
    const tableRef = buildTableRef(dialect, table, schema);
    let next = '';
    if (isEdit && original) {
      next = getAlterBuilder(dialect)(table, original, columns, indexes, tableRef);
    } else if (!isEdit) {
      next = buildCreateTable(dialect, table, columns, indexes, tableRef);
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
              onClick={() => setIndexes((prev) => [...prev, { name: '', unique: false, columns: '', method: DEFAULT_INDEX_METHOD[dialect] }])}>
              <Plus size={12} className="mr-1" />{t('db.designer.addIndex')}
            </Button>
          </div>
          {indexes.map((idx, i) => (
            <div key={`idx-${i}`} className="grid grid-cols-[minmax(100px,1fr)_56px_minmax(84px,92px)_minmax(110px,1.4fr)_28px] gap-1 items-center pb-1">
              <Input className="h-7 font-mono" value={idx.name} disabled={loading} autoComplete="off" spellCheck={false}
                onChange={(e) => setIndex(i, { name: e.target.value })} />
              <label className="flex items-center gap-1 text-muted-foreground">
                <input type="checkbox" checked={idx.unique} disabled={loading}
                  onChange={(e) => setIndex(i, { unique: e.target.checked })} />
                {t('db.workbench.keyMeta.unique')}
              </label>
              <select
                className="h-7 min-w-0 rounded border border-border bg-background px-1 text-xs disabled:opacity-50"
                aria-label={t('db.designer.indexMethod')} title={t('db.designer.indexMethod')}
                value={idx.method} disabled={loading}
                onChange={(e) => setIndex(i, { method: e.target.value })}>
                {INDEX_METHODS[dialect].map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <Input className="h-7 font-mono" value={idx.columns} disabled={loading} autoComplete="off" spellCheck={false}
                placeholder={t('db.grid.filter.column')}
                onChange={(e) => setIndex(i, { columns: e.target.value })} />
              <button type="button" className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-foreground/5"
                title={t('db.action.delete')}
                onClick={() => setIndexes((prev) => prev.filter((_, j) => j !== i))}>
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
    </div>
  );
};

export default SqlTableDesigner;
