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
  assert.match(source, /<RedisOverviewPanel summary=\{redisSummary \?\? \{\}\} db=\{currentDb\} connectionId=\{connectionId\} \/>/);
});

// ——— engine-id threading (Task 9) ——————————————————————————————————————

test('sqlDialect is the engine id (non-redis) with the registry available', () => {
  assert.match(source, /import \{ SQL_ENGINE_BY_ID, type SqlEngineId \} from '\.\.\/\.\.\/domain\/models\/dbEngines'/);
  assert.match(source, /const sqlDialect: SqlEngineId = dialect === 'redis' \? 'postgresql' : dialect;/);
  assert.ok(!source.includes("dialect === 'mysql' ? 'mysql' : 'postgresql'"), 'the two-dialect coercion must be gone');
});

test('menu entries are gated by engine capability, not hardcoded dialect checks', () => {
  // sqlite: no DROP DATABASE menu (file-backed: no db/schema node) and no
  // truncate — both read from the registry, not from probing the SQL builders.
  assert.match(source, /const canDropDatabase = SQL_ENGINE_BY_ID\[sqlDialect\]\.addressMode !== 'file';/);
  assert.match(source, /const canTruncateTables = engineFeatures\.truncate;/);
  assert.match(source, /\.\.\.\(canDropDatabase \? \{/);
  assert.match(source, /\.\.\.\(canTruncateTables \? \{/);
  // Backup/designer entries follow the registry feature flags.
  assert.match(source, /\.\.\.\(engineFeatures\.backupRestore \? \{/);
  assert.match(source, /\.\.\.\(engineFeatures\.designer \? \{/);
  // mssql schema-qualified tree: DROP goes through the schema confirm message.
  assert.match(source, /SQL_ENGINE_BY_ID\[sqlDialect\]\.schemaQualified \? 'db\.tree\.menu\.dropSchemaConfirmMsg' : 'db\.tree\.menu\.dropDbConfirmMsg'/);
});

// ——— top-tab 重新连接 (context menu routes through terminalReconnectRegistry) ———

test('the workbench registers its fresh-dial handler in the terminal reconnect registry', () => {
  // DB sessions bypass TerminalPane, so without this registration the tab
  // context menu's 重新连接 silently queues a handler that never exists.
  assert.match(source, /import \{ terminalReconnectRegistry \} from '\.\.\/\.\.\/application\/state\/terminalReconnectRegistry'/);
  assert.match(source, /terminalReconnectRegistry\.register\(/);
  assert.match(source, /session\.id/);
});

test('the registered handler redials via the hook reconnect and is gated while connecting', () => {
  assert.match(source, /useDatabaseWorkbenchState\(/);
  assert.match(source, /reconnect/);
  assert.match(source, /status !== 'connecting'/);
});

// ——— sessions/erd 只留顶部 tab 入口(工具栏按钮与 tab 重复,已移除) ——————

test('sessions/erd open only via the top tabs — toolbar duplicates are gone', () => {
  // The sqlView toolbar 会话/ER图 buttons duplicated the top-tab viewSwitcher
  // (already !isRedis-gated, which is what the old dialect guard patched).
  // Refresh/disconnect stay generic (any connected protocol).
  assert.ok(!source.includes('ToolbarTextButton'), 'no ToolbarTextButton may remain in the workbench top bar');
  // PlugZap stays: the reconnect button legitimately uses it.
  assert.ok(!source.includes('<Network'), 'the duplicate erd toolbar button must be gone');
  assert.ok(!source.includes('features.sessions && ('), 'the toolbar-only dialect guard goes with the buttons');
  // The panels stay reachable through the top-tab switcher.
  assert.match(source, /'workbench', 'backup', 'sessions', 'erd'/);
  // The sessions tab itself is registry-gated (sqlite features.sessions is
  // false and its bridge has no session handlers — the tab must not render).
  assert.match(source, /view !== 'sessions' \|\| engineFeatures\.sessions/);
});

// ——— db selector follows the server's databases config ——————————————————

test('the db selector builds from the server-reported databases (CONFIG GET), not a hardcoded cap', () => {
  // The flattened INFO summary has no section prefix, and this Redis build's
  // INFO never emits a `databases` line — the old `server.databases` key could
  // never match, so the selector silently always fell back to 16.
  assert.ok(!source.includes("'server.databases'"), 'the never-matching summary key must be gone');
  assert.match(source, /info\.databases/);
  assert.match(source, /REDIS_DB_SELECTOR_CAP/);
});
