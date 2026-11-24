import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./SqlSchemaTree.tsx', import.meta.url), 'utf8');

test('schema tree wires radix context menus around every node kind', () => {
  assert.match(source, /import \{ ContextMenu, ContextMenuTrigger \} from '\.\.\/ui\/context-menu'/);
  assert.match(source, /import \{[^}]*SqlDatabaseContextMenuContent[^}]*\} from '\.\/DatabaseTreeContextMenus'/);
  assert.match(source, /import \{[^}]*SqlTableContextMenuContent[^}]*SqlViewContextMenuContent[^}]*\} from '\.\/DatabaseTreeContextMenus'/);
  // Three trigger sites: db header row, table row, view row. The table/view
  // triggers carry onContextMenu stopPropagation (nested menu bug) — the db
  // row must NOT (it is the topmost trigger).
  const triggers = (source.match(/<ContextMenuTrigger/g) ?? []).length;
  assert.equal(triggers, 3, `expected 3 ContextMenuTrigger sites, found ${triggers}`);
  // db row trigger carries the suppression handler; table/view rows carry
  // stopPropagation — no bare trigger remains.
  assert.equal((source.match(/<ContextMenuTrigger asChild>/g) ?? []).length, 0, 'no bare trigger');
  // Parent-menu suppression: db trigger preventDefaults events originating
  // from nested rows (Radix compose checks defaultPrevented before opening).
  assert.match(source, /closest\?\.\('\[data-tree-row\]'\)/);
  assert.match(source, /data-tree-row="1"/);
});

test('database rows select on click and highlight the selected db', () => {
  assert.match(source, /onSelectDatabase\?[:]\s*[(]name: string[)] => void/);
  assert.match(source, /onSelectDatabase[?][.][(]db[.]name[)]/);
  assert.match(source, /selectedDatabase === db\.name/);
});

test('menus stay optional so the schema tree stays reusable without them', () => {
  assert.match(source, /dbMenu\?:/);
  // Tables and views get separate handler objects so DROP KNOWS the kind.
  assert.match(source, /tableMenu\?:/);
  assert.match(source, /viewMenu\?:/);
});

test('table and view rows pass their own qualified target to the menu', () => {
  assert.match(source, /<SqlTableContextMenuContent[\s\S]*?table=\{table\}/);
  assert.match(source, /<SqlViewContextMenuContent[\s\S]*?view=\{view\}/);
  // Rows feed their handler set (table vs view menus), not a shared object.
  assert.match(source, /<SqlTableContextMenuContent[\s\S]*?\{\.\.\.tableMenu\}/);
  assert.match(source, /<SqlViewContextMenuContent[\s\S]*?\{\.\.\.viewMenu\}/);
});

// ——— engine-id threading (Task 9) ——————————————————————————————————————

test('schema pass-through follows the registry schemaQualified flag (pg + mssql)', () => {
  assert.match(source, /dialect: SqlEngineId/);
  // One registry-driven check per database row feeds all four row sites
  // (table/view rows and their menu contents) via the shared `schema` const.
  const schemaChecks = (source.match(/const schema = SQL_ENGINE_BY_ID\[dialect\]\?\.schemaQualified \? db\.name : undefined;/g) ?? []).length;
  assert.equal(schemaChecks, 1, `expected 1 registry-driven schema check, found ${schemaChecks}`);
  assert.ok(!source.includes("dialect === 'postgresql' ? db.name"), 'the pg-only check must be gone');
  assert.equal(
    (source.match(/\bschema=\{schema\}/g) ?? []).length, 2,
    'both context menus must take the shared schema',
  );
});

test('table and view triggers stop context-menu propagation (nested menu bug)', () => {
  const source = readFileSync(new URL('./SqlSchemaTree.tsx', import.meta.url), 'utf8');
  // Radix triggers do not stopPropagation — without this the schema row's
  // menu overwrites the table/view menu on right-click.
  const count = (source.match(/onContextMenu=\{\(e\) => e\.stopPropagation\(\)\}/g) || []).length;
  assert.equal(count, 2, `expected stopPropagation on table and view triggers, got ${count}`);
});
