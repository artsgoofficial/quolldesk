import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./DatabaseWorkbench.tsx', import.meta.url), 'utf8');

test('workbench owns the destructive SQL builders and confirm dialogs', () => {
  assert.match(source, /import \{ ConfirmDialog \} from '\.\.\/ui\/confirm-dialog'/);
  assert.match(source, /import \{ PromptDialog \} from '\.\.\/ui\/PromptDialog'/);
  assert.match(source, /import \{ dropDatabase, dropTable, dropView, renameObject, seedSelect, truncateTable \} from '\.\/sqlIdent'/);
  assert.match(source, /<ConfirmDialog/);
  assert.match(source, /<PromptDialog/);
});

test('tree menus get dedicated handler sets fed to SqlSchemaTree', () => {
  assert.match(source, /dbMenu=\{/);
  assert.match(source, /tableMenu=\{/);
  assert.match(source, /viewMenu=\{/);
  assert.match(source, /selectedDatabase=\{selectedDatabase\}/);
  assert.match(source, /onSelectDatabase=\{selectDatabase\}/);
});

test('seeded queries flow into the query editor', () => {
  assert.match(source, /seedQuery=\{querySeed\}/);
});

test('destructive statements run through the query bridge and refresh the tree', () => {
  // One runner owns execution so every destructive action shares error surfacing.
  assert.match(source, /const runTreeSql/);
  assert.match(source, /databaseClient\[sqlDialect\]\.query/);
  assert.match(source, /toast\.error\(dbErrorMessage\(err\)\)/);
});

test('copying a node name writes to the clipboard with a confirmation toast', () => {
  assert.match(source, /navigator\.clipboard\.writeText/);
  assert.match(source, /db\.tree\.menu\.copied/);
});

test('pending destructive actions render a destructive confirm button', () => {
  assert.match(source, /destructive/);
  assert.match(source, /busy=\{treeActionBusy\}/);
});

test('serverInfo summary is kept in state and refreshed with the toolbar token', () => {
  assert.match(source, /const \[redisSummary, setRedisSummary\] = useState<Record<string, string> \| null>\(null\)/);
  assert.match(source, /setRedisSummary\(info\.summary\)/);
  // The effect refetches on refresh bumps so the overview stays current.
  assert.match(source, /\[isRedis, isCluster, refreshToken, connectionId\]/);
});

test('the keys view swaps the value viewer for the overview panel when no key is selected', () => {
  assert.match(source, /import RedisOverviewPanel from '\.\/RedisOverviewPanel'/);
  assert.match(source, /selectedKey \? \(/);
  assert.match(source, /<RedisOverviewPanel summary=\{redisSummary \?\? \{\}\} db=\{currentDb\} \/>/);
});
