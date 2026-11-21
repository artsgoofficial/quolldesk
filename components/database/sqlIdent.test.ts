import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  dropDatabase,
  dropTable,
  dropView,
  qualified,
  quoteIdent,
  renameObject,
  seedSelect,
  truncateTable,
} from './sqlIdent';

test('quoteIdent escapes backticks for mysql', () => {
  assert.equal(quoteIdent('mysql', 'we`ird`name'), '`we``ird``name`');
});

test('quoteIdent escapes double quotes for postgresql', () => {
  assert.equal(quoteIdent('postgresql', 'sc"hema'), '"sc""hema"');
});

test('qualified builds a dialect-qualified object name', () => {
  assert.equal(qualified('mysql', 'shop', 'orders'), '`shop`.`orders`');
  assert.equal(qualified('postgresql', 'sales', 'orders'), '"sales"."orders"');
});

test('seedSelect prefixes a cross-db qualified SELECT', () => {
  assert.equal(seedSelect('mysql', 'shop', 'orders'), 'SELECT * FROM `shop`.`orders` LIMIT 100;');
  assert.equal(seedSelect('postgresql', 'sales', 'orders'), 'SELECT * FROM "sales"."orders" LIMIT 100;');
  // Missing db falls back to the bare quoted name (defensive; tree nodes always have one).
  assert.equal(seedSelect('mysql', undefined, 'orders'), 'SELECT * FROM `orders` LIMIT 100;');
});

test('truncateTable emits TRUNCATE TABLE with qualified name', () => {
  assert.equal(truncateTable('mysql', 'shop', 'orders'), 'TRUNCATE TABLE `shop`.`orders`;');
  assert.equal(truncateTable('postgresql', 'sales', 'orders'), 'TRUNCATE TABLE "sales"."orders";');
});

test('dropTable emits DROP TABLE with qualified name', () => {
  assert.equal(dropTable('mysql', 'shop', 'orders'), 'DROP TABLE `shop`.`orders`;');
});

test('dropView emits DROP VIEW with qualified name', () => {
  assert.equal(dropView('postgresql', 'sales', 'active_orders'), 'DROP VIEW "sales"."active_orders";');
});

test('renameObject uses RENAME TABLE on mysql and ALTER on postgresql', () => {
  assert.equal(
    renameObject('mysql', 'shop', 'orders', 'orders_2026'),
    'RENAME TABLE `shop`.`orders` TO `shop`.`orders_2026`;',
  );
  assert.equal(
    renameObject('postgresql', 'sales', 'orders', 'orders_2026'),
    'ALTER TABLE "sales"."orders" RENAME TO "orders_2026";',
  );
  // Views need the dedicated ALTER VIEW on pg (ALTER TABLE fails on a view).
  assert.equal(
    renameObject('postgresql', 'sales', 'active_orders', 'current_orders', 'view'),
    'ALTER VIEW "sales"."active_orders" RENAME TO "current_orders";',
  );
});

test('dropDatabase drops a database on mysql and a schema (cascade) on postgresql', () => {
  assert.equal(dropDatabase('mysql', 'shop'), 'DROP DATABASE `shop`;');
  assert.equal(dropDatabase('postgresql', 'sales'), 'DROP SCHEMA "sales" CASCADE;');
});
