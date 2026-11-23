import assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateSql, GENERATE_KINDS, type SqlGenerateKind } from './sqlGenerate';
import { sqlQuoteIdent, type SqlEngineId } from '../../domain/models/dbEngines';

const COLS = ['id', 'name', 'email'];
const dialects: SqlEngineId[] = ['mysql', 'postgresql', 'mariadb', 'mssql', 'sqlite'];

test('kind set covers the four DML statements', () => {
  assert.deepEqual([...GENERATE_KINDS].sort(), ['delete', 'insert', 'select', 'update']);
});

test('select lists every column and quotes per dialect', () => {
  for (const dialect of dialects) {
    const sql = generateSql(dialect, 'select', 'users', COLS, ['id']);
    const ref = sqlQuoteIdent(dialect, 'users');
    assert.ok(sql.startsWith(`SELECT ${sqlQuoteIdent(dialect, 'id')}, ${sqlQuoteIdent(dialect, 'name')}, ${sqlQuoteIdent(dialect, 'email')} FROM ${ref};`), `${dialect}: ${sql}`);
  }
});

test('insert carries one placeholder row with quoted empty strings', () => {
  const sql = generateSql('postgresql', 'insert', 'users', COLS, ['id']);
  assert.equal(sql, 'INSERT INTO "users" ("id", "name", "email") VALUES (\'\', \'\', \'\');');
});

test('update sets non-pk columns and restricts by the pk', () => {
  const sql = generateSql('mysql', 'update', 'users', COLS, ['id']);
  assert.equal(sql, 'UPDATE `users` SET `name` = \'\', `email` = \'\' WHERE `id` = \'\';');
});

test('delete restricts by the pk', () => {
  const sql = generateSql('sqlite', 'delete', 't', COLS, ['id']);
  assert.equal(sql, 'DELETE FROM "t" WHERE "id" = \'\';');
});

test('composite pk keys produce an AND chain', () => {
  const sql = generateSql('postgresql', 'delete', 'order_lines', ['order_id', 'line_no', 'qty'], ['order_id', 'line_no']);
  assert.ok(sql.includes('WHERE "order_id" = \'\' AND "line_no" = \'\''), sql);
});

test('no pk at all: update/delete stay safe with a 1 = 0 guard', () => {
  const upd = generateSql('mysql', 'update', 'log', ['msg'], []);
  assert.equal(upd, 'UPDATE `log` SET `msg` = \'\' WHERE 1 = 0; /* 无主键，已阻止全表更新 */');
  const del = generateSql('mysql', 'delete', 'log', ['msg'], []);
  assert.equal(del, 'DELETE FROM `log` WHERE 1 = 0; /* 无主键，已阻止全表删除 */');
});

test('empty table name yields empty string (menu guard)', () => {
  for (const kind of GENERATE_KINDS) {
    assert.equal(generateSql('postgresql', kind, '  ', COLS, ['id']), '');
  }
});
