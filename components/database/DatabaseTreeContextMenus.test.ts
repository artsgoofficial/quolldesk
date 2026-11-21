import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Context-menu shells are Radix portals — source-pattern tests like
// components/host/HostTreeContextMenus.test.ts, not static markup.
const source = readFileSync(new URL('./DatabaseTreeContextMenus.tsx', import.meta.url), 'utf8');

test('exports one menu content component per tree node type', () => {
  assert.match(source, /export const SqlDatabaseContextMenuContent/);
  assert.match(source, /export const SqlTableContextMenuContent/);
  assert.match(source, /export const SqlViewContextMenuContent/);
  assert.match(source, /export const RedisKeyContextMenuContent/);
});

test('menus are built from the shared radix primitives', () => {
  assert.match(source, /import \{[^}]*ContextMenuContent[^}]*ContextMenuItem[^}]*\} from '\.\.\/ui\/context-menu'/);
});

test('database menu offers designer, query, refresh, backup and drop', () => {
  assert.match(source, /db\.tree\.menu\.newTable/);
  assert.match(source, /db\.tree\.menu\.newQuery/);
  assert.match(source, /db\.action\.refresh/);
  assert.match(source, /db\.tree\.menu\.backup/);
  assert.match(source, /db\.tree\.menu\.dropDatabase/);
  assert.match(source, /db\.tree\.menu\.dropSchema/);
});

test('table menu offers open, design, structure, query, copy, truncate, rename and drop', () => {
  assert.match(source, /db\.tree\.menu\.openTable/);
  assert.match(source, /db\.tree\.menu\.design/);
  assert.match(source, /db\.workbench\.tab\.structure/);
  assert.match(source, /db\.tree\.menu\.copyName/);
  assert.match(source, /db\.tree\.menu\.truncate/);
  assert.match(source, /common\.rename/);
  assert.match(source, /db\.tree\.menu\.dropTable/);
});

test('view menu skips design and truncate but keeps rename/drop view', () => {
  assert.match(source, /db\.tree\.menu\.dropView/);
  // Design/truncate are table-only: guarded by the shared kind check.
  assert.match(source, /kind === 'table'[^]*?db\.tree\.menu\.design/);
  assert.match(source, /kind === 'table'[^]*?db\.tree\.menu\.truncate/);
});

test('destructive menu items carry the destructive styling', () => {
  // One site each: database drop, object truncate, object drop, redis delete.
  const destructiveCount = (source.match(/text-destructive focus:text-destructive/g) ?? []).length;
  assert.equal(destructiveCount, 4, `expected 4 destructive item sites, found ${destructiveCount}`);
});

test('redis key menu offers open, copy, ttl, rename and delete', () => {
  assert.match(source, /db\.tree\.menu\.openKey/);
  assert.match(source, /db\.tree\.menu\.ttl/);
  assert.match(source, /db\.redis\.removeExpiry/);
  assert.match(source, /common\.delete/);
});

test('menus stay dumb — they invoke handlers, never the bridge or dialogs', () => {
  assert.doesNotMatch(source, /databaseClient/);
  assert.doesNotMatch(source, /ConfirmDialog/);
  assert.doesNotMatch(source, /ipcRenderer/);
});
