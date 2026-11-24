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

test('quoteIdent is backticks on mariadb and brackets on mssql (]] escape)', () => {
  assert.equal(quoteIdent('mariadb', 'we`ird'), '`we``ird`');
  assert.equal(quoteIdent('mssql', 'col]1'), '[col]]1]');
  assert.equal(quoteIdent('sqlite', 'sc"hema'), '"sc""hema"');
});

test('qualified builds a dialect-qualified object name', () => {
  assert.equal(qualified('mysql', 'shop', 'orders'), '`shop`.`orders`');
  assert.equal(qualified('postgresql', 'sales', 'orders'), '"sales"."orders"');
  assert.equal(qualified('mssql', 'dbo', 'orders'), '[dbo].[orders]');
  assert.equal(qualified('sqlite', 'main', 'orders'), '"main"."orders"');
});

test('seedSelect prefixes a cross-db qualified SELECT', () => {
  assert.equal(seedSelect('mysql', 'shop', 'orders'), 'SELECT * FROM `shop`.`orders` LIMIT 100;');
  assert.equal(seedSelect('postgresql', 'sales', 'orders'), 'SELECT * FROM "sales"."orders" LIMIT 100;');
  // Missing db falls back to the bare quoted name (defensive; tree nodes always have one).
  assert.equal(seedSelect('mysql', undefined, 'orders'), 'SELECT * FROM `orders` LIMIT 100;');
});

test('seedSelect uses SELECT TOP on mssql and LIMIT on the rest', () => {
  assert.equal(seedSelect('mssql', 'dbo', 'orders'), 'SELECT TOP 100 * FROM [dbo].[orders];');
  assert.equal(seedSelect('mariadb', 'shop', 'orders'), 'SELECT * FROM `shop`.`orders` LIMIT 100;');
  assert.equal(seedSelect('sqlite', 'main', 'orders'), 'SELECT * FROM "main"."orders" LIMIT 100;');
});

test('truncateTable emits TRUNCATE TABLE with qualified name', () => {
  assert.equal(truncateTable('mysql', 'shop', 'orders'), 'TRUNCATE TABLE `shop`.`orders`;');
  assert.equal(truncateTable('postgresql', 'sales', 'orders'), 'TRUNCATE TABLE "sales"."orders";');
  assert.equal(truncateTable('mssql', 'dbo', 'orders'), 'TRUNCATE TABLE [dbo].[orders];');
});

test('truncateTable is unavailable on sqlite (null hides the menu)', () => {
  assert.equal(truncateTable('sqlite', 'main', 'orders'), null);
});

test('dropTable emits DROP TABLE with qualified name', () => {
  assert.equal(dropTable('mysql', 'shop', 'orders'), 'DROP TABLE `shop`.`orders`;');
  assert.equal(dropTable('mssql', 'dbo', 'orders'), 'DROP TABLE [dbo].[orders];');
});

test('dropView emits DROP VIEW with qualified name', () => {
  assert.equal(dropView('postgresql', 'sales', 'active_orders'), 'DROP VIEW "sales"."active_orders";');
});

test('renameObject uses RENAME TABLE on mysql/mariadb and ALTER on postgresql', () => {
  assert.equal(
    renameObject('mysql', 'shop', 'orders', 'orders_2026'),
    'RENAME TABLE `shop`.`orders` TO `shop`.`orders_2026`;',
  );
  assert.equal(
    renameObject('mariadb', 'shop', 'orders', 'orders_2026'),
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

test('renameObject uses sp_rename on mssql for tables and views', () => {
  assert.equal(renameObject('mssql', 'dbo', 'orders', 'orders_2026'), "EXEC sp_rename '[orders]', 'orders_2026';");
  assert.equal(
    renameObject('mssql', 'dbo', 'active_orders', 'current_orders', 'view'),
    "EXEC sp_rename '[active_orders]', 'current_orders';",
  );
  // A quote in the new name must not break the string literal.
  assert.equal(renameObject('mssql', 'dbo', 'orders', "it's"), "EXEC sp_rename '[orders]', 'it''s';");
});

test('renameObject uses ALTER RENAME TO on sqlite', () => {
  assert.equal(renameObject('sqlite', 'main', 'orders', 'orders_2026'), 'ALTER TABLE "main"."orders" RENAME TO "orders_2026";');
});

test('dropDatabase drops a database on mysql/mariadb and a schema on pg/mssql', () => {
  assert.equal(dropDatabase('mysql', 'shop'), 'DROP DATABASE `shop`;');
  assert.equal(dropDatabase('mariadb', 'shop'), 'DROP DATABASE `shop`;');
  assert.equal(dropDatabase('postgresql', 'sales'), 'DROP SCHEMA "sales" CASCADE;');
  // mssql tree nodes are schemas; no CASCADE (server default is RESTRICT-like behavior for empty schemas).
  assert.equal(dropDatabase('mssql', 'sales'), 'DROP SCHEMA [sales];');
});

test('dropDatabase is unavailable on sqlite (single-file database)', () => {
  assert.equal(dropDatabase('sqlite', 'main'), null);
});
