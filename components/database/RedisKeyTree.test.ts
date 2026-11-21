import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./RedisKeyTree.tsx', import.meta.url), 'utf8');

test('key rows get a radix context menu built from the shared menu content', () => {
  assert.match(source, /import \{ ContextMenu, ContextMenuTrigger \} from '\.\.\/ui\/context-menu'/);
  assert.match(source, /import \{[^}]*RedisKeyContextMenuContent[^}]*\} from '\.\/DatabaseTreeContextMenus'/);
  const triggers = (source.match(/<ContextMenuTrigger asChild>/g) ?? []).length;
  assert.equal(triggers, 1, 'exactly one trigger site: the key row (group headers stay plain)');
  assert.match(source, /<RedisKeyContextMenuContent[\s\S]*?name=\{entry\.name\}/);
});

test('menu actions reuse the existing redis bridge writes', () => {
  assert.match(source, /databaseClient\.redis\.deleteKey/);
  assert.match(source, /databaseClient\.redis\.renameKey/);
  assert.match(source, /databaseClient\.redis\.expireKey/);
});

test('delete goes through a destructive ConfirmDialog, rename and TTL through PromptDialog', () => {
  assert.match(source, /import \{ ConfirmDialog \} from '\.\.\/ui\/confirm-dialog'/);
  assert.match(source, /import \{ PromptDialog \} from '\.\.\/ui\/PromptDialog'/);
  assert.match(source, /<ConfirmDialog[\s\S]*?destructive/);
  assert.match(source, /<PromptDialog/);
});

test('TTL only accepts a positive integer of seconds', () => {
  assert.match(source, /Number\.isInteger/);
  assert.match(source, /db\.tree\.menu\.ttlInvalid/);
});

test('successful rename selects the new key and rescans; errors surface as toasts', () => {
  assert.match(source, /onSelectKey\(newKey/);
  assert.match(source, /onKeysChanged\?\.\(\)/);
  assert.match(source, /toast\.error\(dbErrorMessage\(err\)\)/);
});
