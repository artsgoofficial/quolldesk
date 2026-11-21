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
  designerBlockedReason,
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

const draftIndexes = (rows: { name: string; unique?: boolean; columns: string; method?: string }[]) =>
  rows.map((r) => ({ name: r.name, unique: !!r.unique, columns: r.columns, method: r.method ?? 'BTREE' }));

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

test('COLUMN_TYPES offers dialect-specific suggestions', () => {
  // MySQL-only types must not leak into the pg list.
  for (const t of ['tinyint(1)', 'int', 'decimal(10,2)', 'char(36)', 'datetime', 'json']) {
    assert.ok(COLUMN_TYPES.mysql.includes(t), `mysql should suggest ${t}`);
    assert.ok(!COLUMN_TYPES.postgresql.includes(t), `pg should not suggest ${t}`);
  }
  for (const t of ['smallint', 'integer', 'numeric(10,2)', 'timestamptz', 'jsonb', 'uuid']) {
    assert.ok(COLUMN_TYPES.postgresql.includes(t), `pg should suggest ${t}`);
    assert.ok(!COLUMN_TYPES.mysql.includes(t), `mysql should not suggest ${t}`);
  }
  // Shared basics appear on both sides.
  for (const t of ['bigint', 'varchar(255)', 'text', 'date', 'timestamp', 'boolean']) {
    assert.ok(COLUMN_TYPES.mysql.includes(t) && COLUMN_TYPES.postgresql.includes(t), `${t} suggested on both dialects`);
  }
});

// Registry migration (Task 9): COLUMN_TYPES is now fed from SQL_ENGINES.
// These are the exact literals that used to be hardcoded in the component —
// deep-equal proves the registry feeds identical values (no drift).
const LEGACY_MYSQL_COLUMN_TYPES = ['tinyint(1)', 'int', 'bigint', 'decimal(10,2)', 'varchar(255)', 'char(36)', 'text', 'date', 'datetime', 'timestamp', 'json', 'boolean'];
const LEGACY_PG_COLUMN_TYPES = ['smallint', 'integer', 'bigint', 'numeric(10,2)', 'varchar(255)', 'text', 'date', 'timestamp', 'timestamptz', 'boolean', 'jsonb', 'uuid'];

test('COLUMN_TYPES.mysql deep-equals the pre-registry literal (registry no-drift)', () => {
  assert.deepEqual([...COLUMN_TYPES.mysql], LEGACY_MYSQL_COLUMN_TYPES);
});

test('COLUMN_TYPES.postgresql deep-equals the pre-registry literal (registry no-drift)', () => {
  assert.deepEqual([...COLUMN_TYPES.postgresql], LEGACY_PG_COLUMN_TYPES);
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

// ——— designerBlockedReason (block BEFORE building DDL) ————————————————

test('designerBlockedReason blocks column edits and PK moves on sqlite', () => {
  const typeChange = unchangedCols().map((c) => (c.name === 'title' ? { ...c, type: 'TEXT' } : c));
  assert.equal(designerBlockedReason('sqlite', baseOriginal(), typeChange), 'db.designer.sqliteColumnRebuild');
  const defaultChange = unchangedCols().map((c) => (c.name === 'title' ? { ...c, defaultValue: "'x'" } : c));
  assert.equal(designerBlockedReason('sqlite', baseOriginal(), defaultChange), 'db.designer.sqliteColumnRebuild');
  const pkMove = unchangedCols().map((c) => ({ ...c, pk: c.name === 'title' }));
  assert.equal(designerBlockedReason('sqlite', baseOriginal(), pkMove), 'db.designer.sqliteColumnRebuild');
  // Adds and drops stay allowed.
  const added = [...unchangedCols(), { name: 'score', type: 'TEXT', nullable: true, defaultValue: '', pk: false }];
  assert.equal(designerBlockedReason('sqlite', baseOriginal(), added), null);
  const dropped = unchangedCols().filter((c) => c.name !== 'tags');
  assert.equal(designerBlockedReason('sqlite', baseOriginal(), dropped), null);
  // Dropping the PK column needs a rebuild.
  const pkDropped = unchangedCols().filter((c) => c.name !== 'id');
  assert.equal(designerBlockedReason('sqlite', baseOriginal(), pkDropped), 'db.designer.sqliteColumnRebuild');
});

test('designerBlockedReason blocks default edits on mssql only', () => {
  const defaultChange = unchangedCols().map((c) => (c.name === 'title' ? { ...c, defaultValue: "'n/a'" } : c));
  assert.equal(designerBlockedReason('mssql', baseOriginal(), defaultChange), 'db.designer.mssqlDefaultUnsupported');
  // Type/nullable changes and PK moves are supported on mssql.
  const typeChange = unchangedCols().map((c) => (c.name === 'title' ? { ...c, type: 'nvarchar(max)' } : c));
  assert.equal(designerBlockedReason('mssql', baseOriginal(), typeChange), null);
  const pkMove = unchangedCols().map((c) => ({ ...c, pk: c.name === 'title' }));
  assert.equal(designerBlockedReason('mssql', baseOriginal(), pkMove), null);
});

test('designerBlockedReason never blocks mysql/mariadb/postgresql', () => {
  const defaultChange = unchangedCols().map((c) => (c.name === 'title' ? { ...c, defaultValue: "'n/a'" } : c));
  const pkMove = unchangedCols().map((c) => ({ ...c, pk: c.name === 'title' }));
  for (const engine of ['mysql', 'mariadb', 'postgresql'] as const) {
    assert.equal(designerBlockedReason(engine, baseOriginal(), defaultChange), null, engine);
    assert.equal(designerBlockedReason(engine, baseOriginal(), pkMove), null, engine);
  }
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
    { name: 'idx_title', unique: false, columns: 'title', method: '' },
  ], '"t"');
  assert.ok(sqlite.includes('CREATE INDEX "idx_title" ON "t" ("title")'), sqlite);
  assert.ok(!sqlite.includes('USING'), sqlite);
});

test('type menu renders the dialect list, not a shared one', () => {
  const source = readFileSync(new URL('./SqlTableDesigner.tsx', import.meta.url), 'utf8');
  assert.match(source, /COLUMN_TYPES\[dialect\]/);
  assert.ok(!source.includes('COMMON_TYPES'), 'shared COMMON_TYPES list must be gone');
});
