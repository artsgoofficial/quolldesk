import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { buildAlterMysql, buildAlterPg, buildCreateTable, COLUMN_TYPES, normalizeIndexMethod } from './SqlTableDesigner';

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

test('type menu renders the dialect list, not a shared one', () => {
  const source = readFileSync(new URL('./SqlTableDesigner.tsx', import.meta.url), 'utf8');
  assert.match(source, /COLUMN_TYPES\[dialect\]/);
  assert.ok(!source.includes('COMMON_TYPES'), 'shared COMMON_TYPES list must be gone');
});
