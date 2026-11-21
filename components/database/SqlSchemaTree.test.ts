import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./SqlSchemaTree.tsx', import.meta.url), 'utf8');

test('schema tree wires radix context menus around every node kind', () => {
  assert.match(source, /import \{ ContextMenu, ContextMenuTrigger \} from '\.\.\/ui\/context-menu'/);
  assert.match(source, /import \{[^}]*SqlDatabaseContextMenuContent[^}]*\} from '\.\/DatabaseTreeContextMenus'/);
  assert.match(source, /import \{[^}]*SqlTableContextMenuContent[^}]*SqlViewContextMenuContent[^}]*\} from '\.\/DatabaseTreeContextMenus'/);
  // Three trigger sites: db header row, table row, view row.
  const triggers = (source.match(/<ContextMenuTrigger asChild>/g) ?? []).length;
  assert.equal(triggers, 3, `expected 3 ContextMenuTrigger sites, found ${triggers}`);
});

test('database rows select on click and highlight the selected db', () => {
  assert.match(source, /onSelectDatabase\?\:\s*\(name: string\) => void/);
  assert.match(source, /onSelectDatabase\?\.\(db\.name\)/);
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
  // One registry-driven check feeds all four row sites (table/view rows and
  // their menu contents).
  const schemaChecks = (source.match(/SQL_ENGINE_BY_ID\[dialect\]\?\.schemaQualified \? db\.name : undefined/g) ?? []).length;
  assert.equal(schemaChecks, 4, `expected 4 registry-driven schema checks, found ${schemaChecks}`);
  assert.ok(!source.includes("dialect === 'postgresql' ? db.name"), 'the pg-only check must be gone');
});
