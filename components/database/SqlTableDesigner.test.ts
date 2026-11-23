import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  buildAlterMssql,
  buildAlterMysql,
  buildAlterPg,
  buildAlterSqlite,
  buildCreateTable,
  COLUMN_TYPES,
  getAlterBuilder,
  normalizeIndexMethod,
} from './SqlTableDesigner';

const baseOriginal = () => ({
  columns: [
    { name: 'id', type: 'int', nullable: false, defaultValue: '', pk: true },
    { name: 'title', type: 'varchar(120)', nullable: false, defaultValue: '', pk: false },
    { name: 'tags', type: 'text', nullable: true, defaultValue: '', pk: false },
  ],
  indexes: [] as { name: string; unique: boolean; columns: string[]; method?: string | null }[],
  pkColumn: 'id',
  pkConstraintName: null as string | null,
});

// Draft index rows in the NEW model: each column entry is
// { expr, desc?, nulls? } — strings are normalized to plain column entries.
type DraftEntry = { expr: string; desc?: boolean; nulls?: 'first' | 'last' };
const draftIndexes = (rows: {
  name: string; unique?: boolean; columns: string | string[] | DraftEntry[]; method?: string; where?: string;
}[]) =>
  rows.map((r) => ({
    name: r.name,
    unique: !!r.unique,
    columns: (typeof r.columns === 'string' ? [r.columns] : r.columns).map(
      (c) => (typeof c === 'string' ? { expr: c } : c),
    ),
    method: r.method ?? 'BTREE',
    where: r.where ?? '',
  }));

// Edit mode starts with the loaded columns untouched — pass these so column
// diffing stays quiet and only index statements appear.
const unchangedCols = () => baseOriginal().columns.map((c) => ({ ...c }));

test('mysql alter emits USING for a non-default index method', () => {
  const ddl = buildAlterMysql('artworks', baseOriginal(), unchangedCols(), draftIndexes([
    { name: 'idx_title', columns: 'title', method: 'HASH' },
  ]), '`artworks`');
  assert.equal(ddl, 'ALTER TABLE `artworks` ADD INDEX `idx_title` (`title`) USING HASH;');
});

test('mysql alter omits USING for the default BTREE method', () => {
  const ddl = buildAlterMysql('artworks', baseOriginal(), unchangedCols(), draftIndexes([
    { name: 'idx_title', columns: 'title', method: 'BTREE' },
  ]), '`artworks`');
  assert.equal(ddl, 'ALTER TABLE `artworks` ADD INDEX `idx_title` (`title`);');
});

test('mysql alter recreates an index when its method changes', () => {
  const original = { ...baseOriginal(), indexes: [{ name: 'idx_title', unique: false, columns: ['title'], method: 'BTREE' }] };
  const ddl = buildAlterMysql('artworks', original, unchangedCols(), draftIndexes([
    { name: 'idx_title', columns: 'title', method: 'HASH' },
  ]), '`artworks`');
  assert.deepEqual(ddl.split(';\n'), [
    'ALTER TABLE `artworks` DROP INDEX `idx_title`',
    'ALTER TABLE `artworks` ADD INDEX `idx_title` (`title`) USING HASH;',
  ]);
});

test('mysql alter leaves an unchanged index alone (missing bridge report folds to default)', () => {
  const original = { ...baseOriginal(), indexes: [{ name: 'idx_title', unique: false, columns: ['title'], method: null }] };
  const ddl = buildAlterMysql('artworks', original, unchangedCols(), draftIndexes([
    { name: 'idx_title', columns: 'title', method: 'BTREE' },
  ]), '`artworks`');
  assert.equal(ddl, '');
});

test('pg alter places USING before the column list and recreates on method change', () => {
  const original = { ...baseOriginal(), indexes: [{ name: 'idx_tags', unique: false, columns: ['tags'], method: 'btree' }], pkConstraintName: 'artworks_pkey' };
  const ddl = buildAlterPg('artworks', original, unchangedCols(), draftIndexes([
    { name: 'idx_tags', columns: 'tags', method: 'gin' },
  ]), '"public"."artworks"');
  assert.deepEqual(ddl.split(';\n'), [
    'DROP INDEX "idx_tags"',
    'CREATE INDEX "idx_tags" ON "public"."artworks" USING gin ("tags");',
  ]);
});

test('pg create-table emits USING for non-default methods only', () => {
  const cols = unchangedCols();
  const gin = buildCreateTable('postgresql', 't', cols, draftIndexes([
    { name: 'idx_gin', columns: 'tags', method: 'gin' },
  ]), '"public"."t"');
  assert.ok(gin.includes('CREATE INDEX "idx_gin" ON "public"."t" USING gin ("tags")'), gin);
  const btree = buildCreateTable('postgresql', 't', cols, draftIndexes([
    { name: 'idx_btree', columns: 'tags', method: 'btree' },
  ]), '"public"."t"');
  assert.ok(btree.includes('CREATE INDEX "idx_btree" ON "public"."t" ("tags")'), btree);
  assert.ok(!btree.includes('USING'), btree);
});

test('normalizeIndexMethod maps case-insensitively and passes unknown values through', () => {
  assert.equal(normalizeIndexMethod('mysql', 'BTREE'), 'BTREE');
  assert.equal(normalizeIndexMethod('mysql', 'btree'), 'BTREE');
  assert.equal(normalizeIndexMethod('postgresql', 'GIN'), 'gin');
  assert.equal(normalizeIndexMethod('postgresql', null), 'btree');
  assert.equal(normalizeIndexMethod('postgresql', ''), 'btree');
  assert.equal(normalizeIndexMethod('postgresql', 'hdr'), 'hdr');
});

test('COLUMN_TYPES offers dialect-specific suggestions (expanded DBeaver-style)', () => {
  // MySQL-family idioms must not leak into the pg list (json/jsonb now ship
  // on both sides, as in DBeaver).
  for (const t of ['tinyint(1)', 'mediumint', 'int unsigned', 'bigint unsigned', 'datetime', 'year', "enum('a','b')", "set('a','b')", 'longblob']) {
    assert.ok(COLUMN_TYPES.mysql.includes(t), `mysql should suggest ${t}`);
    assert.ok(!COLUMN_TYPES.postgresql.includes(t), `pg should not suggest ${t}`);
  }
  for (const t of ['integer', 'serial', 'bigserial', 'numeric(10,2)', 'timestamptz', 'jsonb', 'uuid', 'bytea', 'inet', 'money']) {
    assert.ok(COLUMN_TYPES.postgresql.includes(t), `pg should suggest ${t}`);
    assert.ok(!COLUMN_TYPES.mysql.includes(t), `mysql should not suggest ${t}`);
  }
  // Shared basics appear on both sides.
  for (const t of ['bigint', 'varchar(255)', 'text', 'date', 'timestamp', 'boolean', 'json']) {
    assert.ok(COLUMN_TYPES.mysql.includes(t) && COLUMN_TYPES.postgresql.includes(t), `${t} suggested on both dialects`);
  }
  // mssql/sqlite keep their own idioms.
  for (const t of ['nchar(10)', 'datetimeoffset', 'uniqueidentifier', 'sql_variant']) {
    assert.ok(COLUMN_TYPES.mssql.includes(t), `mssql should suggest ${t}`);
  }
  assert.ok(!COLUMN_TYPES.mssql.includes('tinytext'), 'mssql should not suggest mysql blob family');
  for (const t of ['INTEGER', 'CLOB', 'NUMERIC']) {
    assert.ok(COLUMN_TYPES.sqlite.includes(t), `sqlite should suggest ${t}`);
  }
});

// Registry migration (Task 9): COLUMN_TYPES is now fed from SQL_ENGINES.
// These are the exact literals that used to be hardcoded in the component —
// deep-equal proves the registry feeds identical values (no drift).
const CANONICAL_MYSQL_COLUMN_TYPES = ['tinyint(1)', 'tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'int unsigned', 'bigint unsigned', 'decimal(10,2)', 'float', 'double', 'bit(1)', 'boolean', 'char(36)', 'varchar(255)', 'tinytext', 'text', 'mediumtext', 'longtext', 'binary(16)', 'varbinary(255)', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'date', 'time', 'datetime', 'timestamp', 'year', 'json', "enum('a','b')", "set('a','b')"];
const CANONICAL_PG_COLUMN_TYPES = ['smallint', 'integer', 'bigint', 'smallserial', 'serial', 'bigserial', 'numeric(10,2)', 'real', 'double precision', 'money', 'varchar(255)', 'text', 'bytea', 'date', 'time', 'timestamp', 'timestamptz', 'interval', 'boolean', 'json', 'jsonb', 'uuid', 'xml', 'inet', 'cidr', 'macaddr'];

test('COLUMN_TYPES.mysql deep-equals the canonical expanded list (registry no-drift)', () => {
  assert.deepEqual([...COLUMN_TYPES.mysql], CANONICAL_MYSQL_COLUMN_TYPES);
});

test('COLUMN_TYPES.postgresql deep-equals the canonical expanded list (registry no-drift)', () => {
  assert.deepEqual([...COLUMN_TYPES.postgresql], CANONICAL_PG_COLUMN_TYPES);
});

test('normalizeIndexMethod covers the registry engines (mssql/sqlite defaults)', () => {
  assert.equal(normalizeIndexMethod('mssql', null), 'NONCLUSTERED');
  assert.equal(normalizeIndexMethod('mssql', 'clustered'), 'CLUSTERED');
  assert.equal(normalizeIndexMethod('mssql', 'XML_IDX'), 'XML_IDX');
  // sqlite has no access methods: the dropdown default is the empty string.
  assert.equal(normalizeIndexMethod('sqlite', null), '');
  assert.equal(normalizeIndexMethod('mariadb', null), 'BTREE');
});

test('getAlterBuilder dispatches per engine (mariadb shares the mysql builder)', () => {
  assert.equal(getAlterBuilder('mysql'), buildAlterMysql);
  assert.equal(getAlterBuilder('mariadb'), buildAlterMysql);
  assert.equal(getAlterBuilder('postgresql'), buildAlterPg);
  assert.equal(getAlterBuilder('mssql'), buildAlterMssql);
  assert.equal(getAlterBuilder('sqlite'), buildAlterSqlite);
});

test('mysql alter emits USING for a non-default index method', () => {
  const ddl = buildAlterMysql('artworks', baseOriginal(), unchangedCols(), draftIndexes([
    { name: 'idx_title', columns: 'title', method: 'HASH' },
  ]), '`artworks`');
  assert.equal(ddl, 'ALTER TABLE `artworks` ADD INDEX `idx_title` (`title`) USING HASH;');
});

// ——— buildAlterMssql ————————————————————————————————————————————————

const mssqlRef = '[dbo].[artworks]';
const withPkConstraint = (name: string | null) => ({ ...baseOriginal(), pkConstraintName: name });

test('mssql alter adds a column with T-SQL ADD (no COLUMN keyword)', () => {
  const cols = [...unchangedCols(), { name: 'score', type: 'int', nullable: true, defaultValue: '0', pk: false }];
  const ddl = buildAlterMssql('artworks', withPkConstraint(null), cols, [], mssqlRef);
  assert.equal(ddl, `ALTER TABLE ${mssqlRef} ADD [score] int DEFAULT 0;`);
});

test('mssql alter adds a NOT NULL column without a default', () => {
  const cols = [...unchangedCols(), { name: 'score', type: 'int', nullable: false, defaultValue: '', pk: false }];
  const ddl = buildAlterMssql('artworks', withPkConstraint(null), cols, [], mssqlRef);
  assert.equal(ddl, `ALTER TABLE ${mssqlRef} ADD [score] int NOT NULL;`);
});

test('mssql alter rewrites type and nullability via ALTER COLUMN (nullability restated)', () => {
  const cols = unchangedCols().map((c) => (c.name === 'title' ? { ...c, type: 'nvarchar(255)' } : c));
  const ddl = buildAlterMssql('artworks', withPkConstraint(null), cols, [], mssqlRef);
  assert.equal(ddl, `ALTER TABLE ${mssqlRef} ALTER COLUMN [title] nvarchar(255) NOT NULL;`);

  const nullable = unchangedCols().map((c) => (c.name === 'tags' ? { ...c, nullable: false } : c));
  const ddl2 = buildAlterMssql('artworks', withPkConstraint(null), nullable, [], mssqlRef);
  assert.equal(ddl2, `ALTER TABLE ${mssqlRef} ALTER COLUMN [tags] text NOT NULL;`);
});

test('mssql alter throws on a default-value change (v1 unsupported)', () => {
  const cols = unchangedCols().map((c) => (c.name === 'title' ? { ...c, defaultValue: "'n/a'" } : c));
  assert.throws(() => buildAlterMssql('artworks', withPkConstraint(null), cols, [], mssqlRef), /MSSQL_DEFAULT_UNSUPPORTED/);
});

test('mssql alter moves the PK via DROP/ADD CONSTRAINT', () => {
  const cols = unchangedCols().map((c) => ({ ...c, pk: c.name === 'title' }));
  const ddl = buildAlterMssql('artworks', withPkConstraint('PK__artworks__old'), cols, [], mssqlRef);
  assert.deepEqual(ddl.split(';\n'), [
    `ALTER TABLE ${mssqlRef} DROP CONSTRAINT [PK__artworks__old]`,
    `ALTER TABLE ${mssqlRef} ADD CONSTRAINT [PK_artworks] PRIMARY KEY ([title]);`,
  ]);
});

test('mssql alter drops the PK constraint before dropping its column', () => {
  const cols = unchangedCols().filter((c) => c.name !== 'id');
  const ddl = buildAlterMssql('artworks', withPkConstraint('PK__artworks__old'), cols, [], mssqlRef);
  assert.deepEqual(ddl.split(';\n'), [
    `ALTER TABLE ${mssqlRef} DROP CONSTRAINT [PK__artworks__old]`,
    `ALTER TABLE ${mssqlRef} DROP COLUMN [id];`,
  ]);
});

test('mssql alter emits CREATE/DROP INDEX with tsql USING placement (method before INDEX)', () => {
  const clustered = buildAlterMssql('artworks', withPkConstraint(null), unchangedCols(), draftIndexes([
    { name: 'idx_title', unique: true, columns: 'title', method: 'CLUSTERED' },
  ]), mssqlRef);
  assert.equal(clustered, `CREATE UNIQUE CLUSTERED INDEX [idx_title] ON ${mssqlRef} ([title]);`);

  // The default NONCLUSTERED folds away, like BTREE does on mysql.
  const nonClustered = buildAlterMssql('artworks', withPkConstraint(null), unchangedCols(), draftIndexes([
    { name: 'idx_title', unique: true, columns: 'title', method: 'NONCLUSTERED' },
  ]), mssqlRef);
  assert.equal(nonClustered, `CREATE UNIQUE INDEX [idx_title] ON ${mssqlRef} ([title]);`);

  const recreate = buildAlterMssql('artworks', {
    ...baseOriginal(),
    indexes: [{ name: 'idx_title', unique: false, columns: ['title'], method: 'CLUSTERED' }],
    pkConstraintName: null,
  }, unchangedCols(), draftIndexes([
    { name: 'idx_title', columns: 'title', method: 'NONCLUSTERED' },
  ]), mssqlRef);
  assert.deepEqual(recreate.split(';\n'), [
    `DROP INDEX [idx_title] ON ${mssqlRef}`,
    `CREATE INDEX [idx_title] ON ${mssqlRef} ([title]);`,
  ]);
});

test('mssql alter returns an empty string when nothing changed', () => {
  assert.equal(buildAlterMssql('artworks', withPkConstraint('PK__artworks__old'), unchangedCols(), [], mssqlRef), '');
});

// ——— buildAlterSqlite ————————————————————————————————————————————————

const sqliteRef = '"main"."artworks"';

test('sqlite alter supports ADD COLUMN / DROP COLUMN', () => {
  const added = [...unchangedCols(), { name: 'score', type: 'TEXT', nullable: true, defaultValue: '', pk: false }];
  assert.equal(
    buildAlterSqlite('artworks', baseOriginal(), added, [], sqliteRef),
    `ALTER TABLE ${sqliteRef} ADD COLUMN "score" TEXT;`,
  );
  const dropped = unchangedCols().filter((c) => c.name !== 'tags');
  assert.equal(
    buildAlterSqlite('artworks', baseOriginal(), dropped, [], sqliteRef),
    `ALTER TABLE ${sqliteRef} DROP COLUMN "tags";`,
  );
});

test('sqlite alter supports CREATE/DROP INDEX without a method clause', () => {
  const ddl = buildAlterSqlite('artworks', baseOriginal(), unchangedCols(), draftIndexes([
    { name: 'idx_title', unique: true, columns: 'title', method: '' },
  ]), sqliteRef);
  assert.equal(ddl, `CREATE UNIQUE INDEX "idx_title" ON ${sqliteRef} ("title");`);

  const drop = buildAlterSqlite('artworks', {
    ...baseOriginal(),
    indexes: [{ name: 'idx_title', unique: false, columns: ['title'], method: null }],
  }, unchangedCols(), [], sqliteRef);
  assert.equal(drop, 'DROP INDEX "idx_title";');
});

test('sqlite alter throws on column type/nullable/default changes and PK moves', () => {
  const typeChange = unchangedCols().map((c) => (c.name === 'title' ? { ...c, type: 'TEXT' } : c));
  assert.throws(() => buildAlterSqlite('artworks', baseOriginal(), typeChange, [], sqliteRef), /SQLITE_COLUMN_REBUILD_REQUIRED/);

  const nullChange = unchangedCols().map((c) => (c.name === 'tags' ? { ...c, nullable: false } : c));
  assert.throws(() => buildAlterSqlite('artworks', baseOriginal(), nullChange, [], sqliteRef), /SQLITE_COLUMN_REBUILD_REQUIRED/);

  const defaultChange = unchangedCols().map((c) => (c.name === 'title' ? { ...c, defaultValue: "'x'" } : c));
  assert.throws(() => buildAlterSqlite('artworks', baseOriginal(), defaultChange, [], sqliteRef), /SQLITE_COLUMN_REBUILD_REQUIRED/);

  const pkMove = unchangedCols().map((c) => ({ ...c, pk: c.name === 'title' }));
  assert.throws(() => buildAlterSqlite('artworks', baseOriginal(), pkMove, [], sqliteRef), /SQLITE_COLUMN_REBUILD_REQUIRED/);
});

test('sqlite alter throws when the PK column itself is dropped', () => {
  const cols = unchangedCols().filter((c) => c.name !== 'id');
  assert.throws(() => buildAlterSqlite('artworks', baseOriginal(), cols, [], sqliteRef), /SQLITE_COLUMN_REBUILD_REQUIRED/);
});

test('sqlite alter returns an empty string when nothing changed', () => {
  assert.equal(buildAlterSqlite('artworks', baseOriginal(), unchangedCols(), [], sqliteRef), '');
});

// The unsupported-edit rules live only in the builders now: regenerate()
// catches their sentinels (SQLITE_COLUMN_REBUILD_REQUIRED /
// MSSQL_DEFAULT_UNSUPPORTED) and toasts the mapped key. The blocking cases are
// asserted against the builders above; here, the allowed shapes still build.

test('buildAlterSqlite builds for a NEW NOT NULL column WITH a default', () => {
  const withDefault = [...unchangedCols(), { name: 'score', type: 'TEXT', nullable: false, defaultValue: '0', pk: false }];
  assert.equal(
    buildAlterSqlite('artworks', baseOriginal(), withDefault, [], sqliteRef),
    `ALTER TABLE ${sqliteRef} ADD COLUMN "score" TEXT NOT NULL DEFAULT 0;`,
  );
});

// ——— index-method USING fragments follow indexMethodStyle —————————————

test('create-table index statements place USING per indexMethodStyle', () => {
  // mysql style: USING after the column list.
  const mysql = buildCreateTable('mysql', 't', unchangedCols(), draftIndexes([
    { name: 'idx_title', columns: 'title', method: 'HASH' },
  ]), '`t`');
  assert.ok(mysql.includes('CREATE INDEX `idx_title` ON `t` (`title`) USING HASH'), mysql);

  // pg style: USING between ON and the column list.
  const pg = buildCreateTable('postgresql', 't', unchangedCols(), draftIndexes([
    { name: 'idx_gin', columns: 'tags', method: 'gin' },
  ]), '"t"');
  assert.ok(pg.includes('CREATE INDEX "idx_gin" ON "t" USING gin ("tags")'), pg);

  // tsql style: method between UNIQUE and INDEX.
  const mssql = buildCreateTable('mssql', 't', unchangedCols(), draftIndexes([
    { name: 'idx_title', columns: 'title', method: 'CLUSTERED' },
  ]), '[t]');
  assert.ok(mssql.includes('CREATE CLUSTERED INDEX [idx_title] ON [t] ([title])'), mssql);

  // none (sqlite): never a USING fragment.
  const sqlite = buildCreateTable('sqlite', 't', unchangedCols(), [
    { name: 'idx_title', unique: false, columns: [{ expr: 'title' }], method: '', where: '' },
  ], '"t"');
  assert.ok(sqlite.includes('CREATE INDEX "idx_title" ON "t" ("title")'), sqlite);
  assert.ok(!sqlite.includes('USING'), sqlite);
});

test('type menu renders the dialect list, not a shared one', () => {
  const source = readFileSync(new URL('./SqlTableDesigner.tsx', import.meta.url), 'utf8');
  assert.match(source, /COLUMN_TYPES\[dialect\]/);
  assert.ok(!source.includes('COMMON_TYPES'), 'shared COMMON_TYPES list must be gone');
});

// ——— composite / DESC / NULLS / WHERE / expression matrix (DBeaver-parity) ———

test('mysql alter renders composite columns in order', () => {
  const ddl = buildAlterMysql('artworks', baseOriginal(), unchangedCols(), draftIndexes([
    { name: 'idx_tt', columns: ['title', 'tags'] },
  ]), '`artworks`');
  assert.equal(ddl, 'ALTER TABLE `artworks` ADD INDEX `idx_tt` (`title`, `tags`);');
});

test('mysql alter renders per-column DESC (syntactically valid, InnoDB ignores)', () => {
  const ddl = buildAlterMysql('artworks', baseOriginal(), unchangedCols(), draftIndexes([
    { name: 'idx_t', columns: [{ expr: 'title', desc: true }] },
  ]), '`artworks`');
  assert.equal(ddl, 'ALTER TABLE `artworks` ADD INDEX `idx_t` (`title` DESC);');
});

test('nulls ordering renders only on postgresql (silently dropped elsewhere)', () => {
  const pg = buildAlterPg('artworks', baseOriginal(), unchangedCols(), draftIndexes([
    { name: 'idx_t', columns: [{ expr: 'title', nulls: 'first' }], method: 'btree' },
  ]), '"public"."artworks"');
  assert.equal(pg, 'CREATE INDEX "idx_t" ON "public"."artworks" ("title" NULLS FIRST);');
  const mysql = buildAlterMysql('artworks', baseOriginal(), unchangedCols(), draftIndexes([
    { name: 'idx_t', columns: [{ expr: 'title', nulls: 'first' }] },
  ]), '`artworks`');
  assert.equal(mysql, 'ALTER TABLE `artworks` ADD INDEX `idx_t` (`title`);');
});

test('pg alter recreates when desc/nulls change a previously plain index', () => {
  const original = { ...baseOriginal(), indexes: [{ name: 'idx_t', unique: false, columns: ['tags'], method: 'btree' }] };
  const ddl = buildAlterPg('artworks', original, unchangedCols(), draftIndexes([
    { name: 'idx_t', columns: [{ expr: 'tags', desc: true, nulls: 'last' }], method: 'btree' },
  ]), '"public"."artworks"');
  assert.deepEqual(ddl.split(';\n'), [
    'DROP INDEX "idx_t"',
    'CREATE INDEX "idx_t" ON "public"."artworks" ("tags" DESC NULLS LAST);',
  ]);
});

test('pg passes expression entries through unquoted, mixed with plain columns', () => {
  const ddl = buildAlterPg('artworks', baseOriginal(), unchangedCols(), draftIndexes([
    { name: 'idx_expr', columns: [{ expr: 'title' }, { expr: 'lower(tags)' }], method: 'btree' },
  ]), '"public"."artworks"');
  assert.equal(ddl, 'CREATE INDEX "idx_expr" ON "public"."artworks" ("title", lower(tags));');
});

test('pg expression pairs with USING and WHERE (partial index)', () => {
  const ddl = buildAlterPg('artworks', baseOriginal(), unchangedCols(), draftIndexes([
    { name: 'idx_active', columns: [{ expr: 'lower(title)', desc: true }], method: 'gin', where: 'deleted_at IS NULL' },
  ]), '"public"."artworks"');
  assert.equal(ddl, 'CREATE INDEX "idx_active" ON "public"."artworks" USING gin (lower(title) DESC) WHERE deleted_at IS NULL;');
});

test('pg alter recreates when the WHERE predicate changes', () => {
  const original = { ...baseOriginal(), indexes: [{ name: 'idx_a', unique: false, columns: ['title'], method: null, where: 'deleted_at IS NULL' }] };
  const ddl = buildAlterPg('artworks', original, unchangedCols(), draftIndexes([
    { name: 'idx_a', columns: ['title'], method: 'btree', where: 'deleted_at IS NOT NULL' },
  ]), '"public"."artworks"');
  assert.deepEqual(ddl.split(';\n'), [
    'DROP INDEX "idx_a"',
    'CREATE INDEX "idx_a" ON "public"."artworks" ("title") WHERE deleted_at IS NOT NULL;',
  ]);
});

test('pg alter leaves a bridge-loaded index untouched (no false recreate)', () => {
  const original = { ...baseOriginal(), indexes: [{ name: 'idx_tt', unique: false, columns: ['title', 'tags'], method: null }] };
  const ddl = buildAlterPg('artworks', original, unchangedCols(), draftIndexes([
    { name: 'idx_tt', columns: ['title', 'tags'], method: 'btree' },
  ]), '"public"."artworks"');
  assert.equal(ddl, '');
});

test('mssql filtered index appends WHERE', () => {
  const ddl = buildAlterMssql('artworks', baseOriginal(), unchangedCols(), draftIndexes([
    { name: 'idx_t', unique: true, columns: ['title'], method: 'NONCLUSTERED', where: 'deleted = 0' },
  ]), mssqlRef);
  assert.equal(ddl, `CREATE UNIQUE INDEX [idx_t] ON ${mssqlRef} ([title]) WHERE deleted = 0;`);
});

test('sqlite partial index appends WHERE', () => {
  const ddl = buildAlterSqlite('artworks', baseOriginal(), unchangedCols(), draftIndexes([
    { name: 'idx_t', unique: true, columns: ['title'], method: '', where: 'tags IS NOT NULL' },
  ]), sqliteRef);
  assert.equal(ddl, `CREATE UNIQUE INDEX "idx_t" ON ${sqliteRef} ("title") WHERE tags IS NOT NULL;`);
});

test('non-pg entries containing parens stay quoted (mysql prefix length stays unsupported)', () => {
  const ddl = buildAlterMysql('artworks', baseOriginal(), unchangedCols(), draftIndexes([
    { name: 'idx_t', columns: ['title(191)'] },
  ]), '`artworks`');
  assert.equal(ddl, 'ALTER TABLE `artworks` ADD INDEX `idx_t` (`title(191)`);');
});

test('create-table composite+where flows through every builder shape', () => {
  const entries = [{ expr: 'title' }, { expr: 'tags', desc: true }];
  const pg = buildCreateTable('postgresql', 't', unchangedCols(), draftIndexes([
    { name: 'idx_tt', columns: entries, method: 'btree', where: 'deleted = 0' },
  ]), '"public"."t"');
  assert.ok(pg.includes('CREATE INDEX "idx_tt" ON "public"."t" ("title", "tags" DESC) WHERE deleted = 0;'), pg);
  const mssql = buildCreateTable('mssql', 't', unchangedCols(), draftIndexes([
    { name: 'idx_tt', unique: true, columns: entries, method: 'NONCLUSTERED', where: 'deleted = 0' },
  ]), '[dbo].[t]');
  assert.ok(mssql.includes('CREATE UNIQUE INDEX [idx_tt] ON [dbo].[t] ([title], [tags] DESC) WHERE deleted = 0;'), mssql);
});

test('index column sub-rows UI: picker popover, sort/nulls selects, where gated per engine', () => {
  const source = readFileSync(new URL('./SqlTableDesigner.tsx', import.meta.url), 'utf8');
  // Entry model + column sub-row editing helpers.
  assert.match(source, /IndexColumnEntry/);
  assert.match(source, /removeIndexColumn/);
  assert.match(source, /moveIndexColumn/);
  // Picker popover state (native datalist/multiple are avoided in Electron).
  assert.match(source, /indexColumnMenu/);
  // No native <datalist> element: Electron datalist is avoided repo-wide (comment mentions are fine).
  assert.doesNotMatch(source, /<datalist/);
  // Per-engine gating from the registry descriptor.
  assert.match(source, /features\.indexWhere/);
  assert.match(source, /features\.indexNulls/);
  // Strict DBeaver layout: selected row drives the add/move/delete toolbar;
  // grid headers (Indexes list + key-part columns) come from i18n keys.
  assert.match(source, /selectedKeyPart/);
  assert.match(source, /insertIndexColumn/);
  assert.match(source, /indexKeyColumn/);
  assert.match(source, /indexColumnName/);
  // Bridge-loaded indexes map straight into entries (no join/split round trip).
  assert.match(source, /\.columns\.map\(\(expr\)/);
});

// ——— foreign keys: canonical load shape, DDL, diff walk ————————————————

const draftFks = (rows: { name: string; columns: string; refTable: string; refColumns: string; onDelete?: string; onUpdate?: string }[]) =>
  rows.map((r) => ({ name: r.name, columns: r.columns, refTable: r.refTable, refColumns: r.refColumns, onDelete: r.onDelete ?? '', onUpdate: r.onUpdate ?? '' }));

const baseOriginalWithFks = () => ({
  ...baseOriginal(),
  foreignKeys: [
    { name: 'fk_users_parent', columns: ['parent_id'], refTable: 'user_groups', refSchema: 'public', refColumns: ['id'], onDelete: 'NO ACTION', onUpdate: 'NO ACTION' },
  ] as OriginalTable['foreignKeys'],
});

test('pg alter adds a named FK constraint with actions', () => {
  const original = { ...baseOriginalWithFks(), foreignKeys: [] };
  const ddl = buildAlterPg('artworks', original, unchangedCols(), draftIndexes([]), '"public"."artworks"', draftFks([
    { name: 'fk_art_parent', columns: 'parent_id', refTable: 'user_groups', refColumns: 'id', onDelete: 'CASCADE' },
  ]));
  assert.equal(ddl, 'ALTER TABLE "public"."artworks" ADD CONSTRAINT "fk_art_parent" FOREIGN KEY ("parent_id") REFERENCES "user_groups" ("id") ON DELETE CASCADE;');
});

test('pg alter drops a removed FK and recreates a changed one', () => {
  const ddl = buildAlterPg('artworks', baseOriginalWithFks(), unchangedCols(), draftIndexes([]), '"public"."artworks"', draftFks([
    { name: 'fk_users_parent', columns: 'parent_id', refTable: 'user_groups', refColumns: 'id', onDelete: 'CASCADE' },
  ]));
  assert.deepEqual(ddl.split(';\n'), [
    'ALTER TABLE "public"."artworks" DROP CONSTRAINT "fk_users_parent"',
    'ALTER TABLE "public"."artworks" ADD CONSTRAINT "fk_users_parent" FOREIGN KEY ("parent_id") REFERENCES "user_groups" ("id") ON DELETE CASCADE;',
  ]);
});

test('pg alter leaves an unchanged FK alone (NO ACTION folds both ways)', () => {
  const ddl = buildAlterPg('artworks', baseOriginalWithFks(), unchangedCols(), draftIndexes([]), '"public"."artworks"', draftFks([
    { name: 'fk_users_parent', columns: 'parent_id', refTable: 'user_groups', refColumns: 'id' },
  ]));
  assert.equal(ddl, '');
});

test('mysql alter uses DROP FOREIGN KEY / ADD CONSTRAINT', () => {
  const ddl = buildAlterMysql('artworks', baseOriginalWithFks(), unchangedCols(), draftIndexes([]), '`artworks`', draftFks([
    { name: 'fk_users_parent', columns: 'parent_id', refTable: 'user_groups', refColumns: 'id' },
  ]).filter((_, i) => i === -1));
  assert.equal(ddl, 'ALTER TABLE `artworks` DROP FOREIGN KEY `fk_users_parent`;');
});

test('mssql alter adds the FK through ADD CONSTRAINT', () => {
  const original = { ...baseOriginalWithFks(), foreignKeys: [] };
  const ddl = buildAlterMssql('artworks', original, unchangedCols(), draftIndexes([]), '[dbo].[artworks]', draftFks([
    { name: 'fk_art_parent', columns: 'parent_id', refTable: 'user_groups', refColumns: 'id' },
  ]));
  assert.equal(ddl, 'ALTER TABLE [dbo].[artworks] ADD CONSTRAINT [fk_art_parent] FOREIGN KEY ([parent_id]) REFERENCES [user_groups] ([id]);');
});

test('create table inlines FK constraints for mysql and sqlite, ALTER for pg', () => {
  const fks = draftFks([{ name: 'fk_t', columns: 'a, b', refTable: 'p', refColumns: 'x, y' }]);
  const mysql = buildCreateTable('mysql', 't', unchangedCols(), [], '`t`', fks);
  assert.ok(mysql.includes('  CONSTRAINT `fk_t` FOREIGN KEY (`a`, `b`) REFERENCES `p` (`x`, `y`)'), mysql);
  const sqlite = buildCreateTable('sqlite', 't', unchangedCols(), [], '"t"', fks);
  assert.ok(sqlite.includes('CONSTRAINT "fk_t" FOREIGN KEY ("a", "b") REFERENCES "p" ("x", "y")'), sqlite);
  const pg = buildCreateTable('postgresql', 't', unchangedCols(), [], '"public"."t"', fks);
  assert.ok(pg.includes('ALTER TABLE "public"."t" ADD CONSTRAINT "fk_t" FOREIGN KEY ("a", "b") REFERENCES "p" ("x", "y")'), pg);
});

test('the designer renders an FK section gated off for sqlite ALTER changes', () => {
  const source = readFileSync(new URL('./SqlTableDesigner.tsx', import.meta.url), 'utf8');
  assert.match(source, /diffForeignKeys\(original\.foreignKeys/);
  assert.match(source, /db\.designer\.addForeignKey/);
  assert.match(source, /fkSqliteHint/);
  assert.match(source, /setForeignKeys\(fkDrafts\)/);
});
