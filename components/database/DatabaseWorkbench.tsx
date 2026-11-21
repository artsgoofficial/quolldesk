import { PlugZap, RefreshCw } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { Host, TerminalSession } from '../../domain/models';
import { resolveDbSessionTabStatus } from '../../domain/models/database';
import { useDatabaseWorkbenchState } from '../../application/state/useDatabaseWorkbenchState';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { PromptDialog } from '../ui/PromptDialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { databaseClient, dbErrorMessage } from '@/infrastructure/services/databaseClient';
import { toast } from '../ui/toast';
import RedisPubSub from './RedisPubSub';
import RedisConsole from './RedisConsole';
import RedisKeyTree from './RedisKeyTree';
import RedisValueViewer from './RedisValueViewer';
import RedisOverviewPanel from './RedisOverviewPanel';
import SqlSchemaTree from './SqlSchemaTree';
import SqlTableStructure from './SqlTableStructure';
import SqlTableDesigner from './SqlTableDesigner';
import SqlTableData from './SqlTableData';
import SqlQueryEditor from './SqlQueryEditor';
import SqlBackupRestore from './SqlBackupRestore';
import type { SqlDatabaseContextMenuHandlers, SqlObjectContextMenuHandlers, SqlViewContextMenuHandlers } from './DatabaseTreeContextMenus';
import { dropDatabase, dropTable, dropView, renameObject, seedSelect, truncateTable } from './sqlIdent';

interface DatabaseWorkbenchProps {
  session: TerminalSession;
  host: Host;
  hosts?: Host[];
  /** Report the connection lifecycle to the session store (tab status dot). */
  onStatusChange?: (sessionId: string, status: TerminalSession['status']) => void;
}

const STATUS_LABEL_KEYS: Record<string, string> = {
  idle: 'db.status.idle',
  connecting: 'db.status.connecting',
  connected: 'db.status.connected',
  error: 'db.status.error',
  disconnected: 'db.status.disconnected',
};

const STATUS_COLORS: Record<string, string> = {
  idle: 'bg-muted-foreground',
  connecting: 'bg-amber-500 animate-pulse',
  connected: 'bg-emerald-500',
  error: 'bg-destructive',
  disconnected: 'bg-muted-foreground',
};

const DatabaseWorkbench: React.FC<DatabaseWorkbenchProps> = ({ session, host, hosts, onStatusChange }) => {
  const { t } = useI18n();
  // Fires when the main process dropped the connection (idle reap / server
  // death): the hook has already flipped to 'disconnected' — surface why.
  const handleConnectionLost = useCallback(() => {
    toast.error(t('db.workbench.connectionLost'));
  }, [t]);
  const { status, connectionId, errorMessage, connect, disconnect, dialect } =
    useDatabaseWorkbenchState({ session, host, hosts, onConnectionLost: handleConnectionLost });
  const [refreshToken, setRefreshToken] = useState(0);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [selectedSchema, setSelectedSchema] = useState<string | undefined>(undefined);
  // FK jump-through (SqlTableData): seed filter applied on the target table.
  // jumpCounter marks fresh navigations so stale seeds are not re-applied.
  const [jumpFilter, setJumpFilter] = useState<{ column: string; value: string } | null>(null);
  const [jumpCounter, setJumpCounter] = useState(0);
  const [sqlTab, setSqlTab] = useState<'structure' | 'data' | 'query'>('data');
  const [redisView, setRedisView] = useState<'keys' | 'pubsub' | 'console'>('keys');
  // SQL full-area views: the workbench grid or the backup/restore panel
  // (switcher in the toolbar, mirroring the redis keys/pubsub/console views).
  const [sqlView, setSqlView] = useState<'workbench' | 'backup'>('workbench');
  // Visual table designer (SQL dialects only): open with editingTable=null for
  // create mode, or the table name to prefill from tableMeta (edit mode).
  const [designerTable, setDesignerTable] = useState<string | null>(null);
  const [designerOpen, setDesignerOpen] = useState(false);
  // Redis logical database (single-connection SELECT). Defaults to the host's
  // configured db; reset whenever a (re)connection is established because the
  // bridge dials back into the configured db.
  const [currentDb, setCurrentDb] = useState<number>(host.redisConfig?.redisDb ?? 0);
  const [dbOptions, setDbOptions] = useState<{ db: number; keys: number }[] | null>(null);
  // Cluster masters from the shared serverInfo fetch (RedisKeyTree consumes
  // them instead of issuing its own INFO round trip).
  const [clusterNodes, setClusterNodes] = useState<{ nodeId: string; host: string; port: number }[] | null>(null);
  // Flattened INFO summary from the same fetch — feeds the keys-view overview
  // panel (server/memory/keyspace/activity cards) in the right-column empty state.
  const [redisSummary, setRedisSummary] = useState<Record<string, string> | null>(null);
  // Schema-tree context menus (Navicat-style): selected db node, seeded query
  // tabs, and the pending destructive/rename actions (confirm dialogs own the
  // actual execution — the menus stay dumb).
  const [selectedDatabase, setSelectedDatabase] = useState<string | undefined>(undefined);
  const [querySeed, setQuerySeed] = useState<{ sql: string; token: number } | undefined>(undefined);
  const seedCounterRef = useRef(0);
  const [treeConfirm, setTreeConfirm] = useState<{ title: string; message: string; sql: string; confirmLabel: string } | null>(null);
  const [treeActionBusy, setTreeActionBusy] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ object: string; schema?: string; kind: 'table' | 'view' } | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);

  const isRedis = dialect === 'redis';
  const isCluster = isRedis && host.redisConfig?.cluster === true;
  // The SQL views all take the non-redis dialect; narrow once here instead of
  // re-coercing at every prop site.
  const sqlDialect: 'mysql' | 'postgresql' = dialect === 'mysql' ? 'mysql' : 'postgresql';

  // DB sessions bypass TerminalPane, so nothing else updates the session's
  // status — without this the top-tab dot stays on its initial 'connecting'.
  useEffect(() => {
    const nextStatus = resolveDbSessionTabStatus(status);
    if (nextStatus) onStatusChange?.(session.id, nextStatus);
  }, [onStatusChange, session.id, status]);

  useEffect(() => {
    setCurrentDb(host.redisConfig?.redisDb ?? 0);
    // A new connection dials into its own configured db/schema — stale tree
    // menu state (selected db node, seeded query) must not leak across.
    setSelectedDatabase(undefined);
    setQuerySeed(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  // One serverInfo round trip per connection (refetched on refresh bumps)
  // feeds the db selector, the key tree's cluster-node list, and the overview
  // panel — all three used to fetch INFO separately.
  useEffect(() => {
    if (!isRedis || !connectionId) { setDbOptions(null); setClusterNodes(null); setRedisSummary(null); return; }
    let alive = true;
    (async () => {
      try {
        const info = await databaseClient.redis.serverInfo({ connectionId });
        if (!alive) return;
        setRedisSummary(info.summary);
        setClusterNodes(info.nodes && info.nodes.length > 1 ? info.nodes : null);
        if (isCluster) { setDbOptions(null); return; }
        const total = Math.min(Number(info.summary['server.databases'] ?? 16) || 16, 16);
        const options: { db: number; keys: number }[] = [];
        for (let i = 0; i < total; i++) {
          // INFO keyspace lines are "db0:keys=..." → summary key is `db0`.
          const match = info.summary[`db${i}`]?.match(/keys=(\d+)/);
          options.push({ db: i, keys: match ? Number(match[1]) : 0 });
        }
        setDbOptions(options);
      } catch {
        if (alive) { setDbOptions(null); setClusterNodes(null); setRedisSummary(null); }
      }
    })();
    return () => { alive = false; };
  }, [isRedis, isCluster, refreshToken, connectionId]);

  const switchDb = async (next: number) => {
    if (next === currentDb || !connectionId) return;
    try {
      await databaseClient.redis.selectDb({ connectionId, db: next });
      setCurrentDb(next);
      setSelectedKey(null);
      setSelectedNodeId(undefined);
      setRefreshToken((r) => r + 1);
    } catch (err) {
      const message = dbErrorMessage(err);
      toast.error(message, t('db.workbench.selectDbFailed'));
    }
  };

  // Redis keyspace changed (key created / renamed / deleted): rescan the tree.
  const bumpRedisRefresh = () => setRefreshToken((v) => v + 1);

  // Designer open/edit entry points (SQL tree [+], structure-tab [design] button).
  // Opening the designer leaves the backup view (full-area views are exclusive).
  const openDesigner = (table: string | null) => { setDesignerTable(table); setDesignerOpen(true); setSqlView('workbench'); };
  // Success bumps refreshToken so the schema tree and structure tab reload.
  const designerDone = () => { setDesignerOpen(false); setRefreshToken((v) => v + 1); };

  // ——— Schema-tree context menus (Navicat-style) ————————————————————————
  const bumpRefresh = () => setRefreshToken((v) => v + 1);
  const seedNewQuery = (sql: string) => {
    seedCounterRef.current += 1;
    setQuerySeed({ sql, token: seedCounterRef.current });
  };
  // Clicking a db row targets it: designer create + backup scope + new tables
  // follow this db/schema until another table/db row is clicked.
  const selectDatabase = (name: string) => {
    setSelectedDatabase(name);
    setSelectedSchema(name);
    setSelectedTable(null);
  };
  // Single runner for destructive tree SQL (truncate/drop/drop-db): shared
  // error surfacing, and a refresh bump on success. Statements were already
  // confirmed through ConfirmDialog before getting here.
  const runTreeSql = async (sql: string) => {
    if (!connectionId) return;
    setTreeActionBusy(true);
    try {
      await databaseClient[sqlDialect].query({ connectionId, sql });
      bumpRefresh();
    } catch (err) {
      toast.error(dbErrorMessage(err));
    } finally {
      setTreeActionBusy(false);
    }
  };
  const copyName = (name: string) => {
    navigator.clipboard.writeText(name)
      .then(() => toast.success(t('db.tree.menu.copied')))
      .catch(() => {});
  };
  const selectObject = (object: string, schema?: string) => {
    setSelectedTable(object);
    setSelectedSchema(schema);
  };
  const dbMenu: SqlDatabaseContextMenuHandlers = {
    onNewTable: (name) => { selectDatabase(name); openDesigner(null); },
    onNewQuery: (name) => { selectDatabase(name); setSqlTab('query'); seedNewQuery(''); },
    onRefresh: bumpRefresh,
    onBackup: (name) => { selectDatabase(name); setSqlView('backup'); },
    onDrop: (name) => setTreeConfirm({
      title: t('db.tree.menu.dropConfirmTitle', { name }),
      message: t(sqlDialect === 'postgresql' ? 'db.tree.menu.dropSchemaConfirmMsg' : 'db.tree.menu.dropDbConfirmMsg', { name }),
      sql: dropDatabase(sqlDialect, name),
      confirmLabel: t('db.tree.menu.confirmDrop'),
    }),
  };
  const tableMenu: SqlObjectContextMenuHandlers = {
    onOpenData: (table, schema) => { selectObject(table, schema); setSqlTab('data'); },
    onDesign: (table, schema) => { selectObject(table, schema); openDesigner(table); },
    onOpenStructure: (table, schema) => { selectObject(table, schema); setSqlTab('structure'); },
    onNewQuery: (table, schema) => {
      selectObject(table, schema);
      setSqlTab('query');
      seedNewQuery(seedSelect(sqlDialect, schema, table));
    },
    onCopyName: copyName,
    onTruncate: (table, schema) => setTreeConfirm({
      title: t('db.tree.menu.truncateConfirmTitle', { name: table }),
      message: t('db.tree.menu.truncateConfirmMsg', { name: table }),
      sql: truncateTable(sqlDialect, schema, table),
      confirmLabel: t('db.tree.menu.confirmTruncate'),
    }),
    onRename: (object, schema) => setRenameTarget({ object, schema, kind: 'table' }),
    onDrop: (object, schema) => setTreeConfirm({
      title: t('db.tree.menu.dropConfirmTitle', { name: object }),
      message: t('db.tree.menu.dropConfirmMsg', { name: object }),
      sql: dropTable(sqlDialect, schema, object),
      confirmLabel: t('db.tree.menu.confirmDrop'),
    }),
  };
  const viewMenu: SqlViewContextMenuHandlers = {
    onOpenData: (view, schema) => { selectObject(view, schema); setSqlTab('data'); },
    onOpenStructure: (view, schema) => { selectObject(view, schema); setSqlTab('structure'); },
    onNewQuery: (view, schema) => {
      selectObject(view, schema);
      setSqlTab('query');
      seedNewQuery(seedSelect(sqlDialect, schema, view));
    },
    onCopyName: copyName,
    onRename: (object, schema) => setRenameTarget({ object, schema, kind: 'view' }),
    onDrop: (object, schema) => setTreeConfirm({
      title: t('db.tree.menu.dropConfirmTitle', { name: object }),
      message: t('db.tree.menu.dropConfirmMsg', { name: object }),
      sql: dropView(sqlDialect, schema, object),
      confirmLabel: t('db.tree.menu.confirmDrop'),
    }),
  };
  const confirmRename = async (newName: string) => {
    if (!renameTarget || !connectionId) return;
    setRenameBusy(true);
    try {
      await databaseClient[sqlDialect].query({
        connectionId,
        sql: renameObject(sqlDialect, renameTarget.schema, renameTarget.object, newName, renameTarget.kind),
      });
      // Keep the open structure/data tabs following the renamed object.
      if (selectedTable === renameTarget.object) setSelectedTable(newName);
      if (selectedDatabase === renameTarget.object) setSelectedDatabase(newName);
      setRenameTarget(null);
      bumpRefresh();
    } catch (err) {
      toast.error(dbErrorMessage(err));
    } finally {
      setRenameBusy(false);
    }
  };

  // FK jump-through (clicked ↗ on an FK cell): select the referenced table,
  // seed its grid filter with { referenced column = clicked value }, bump the
  // jump counter and switch to the data tab.
  const navigateForeignKey = (target: { table: string; schema?: string; column: string; value: string }) => {
    setSelectedTable(target.table);
    setSelectedSchema(target.schema);
    setJumpFilter({ column: target.column, value: target.value });
    setJumpCounter((c) => c + 1);
    setSqlTab('data');
  };

  // Toolbar view switchers share one row style; labels are i18n key suffixes
  // (db.workbench.view.<view>; backup's label lives at db.backup.title).
  const viewSwitcher = (
    views: readonly string[], active: string, onPick: (view: string) => void, label: (view: string) => string,
  ) => (
    <div className="flex gap-0.5 ml-2">
      {views.map((view) => (
        <button key={view} type="button"
          className={`px-2 py-1 rounded text-xs ${active === view ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:bg-foreground/5'}`}
          onClick={() => onPick(view)}>
          {label(view)}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col h-full w-full bg-background">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60 app-no-drag shrink-0">
        <span className={`w-2 h-2 rounded-full ${STATUS_COLORS[status] ?? 'bg-muted-foreground'}`} />
        <span className="text-sm font-medium truncate">{session.hostLabel}</span>
        <span className="text-xs text-muted-foreground">{t(STATUS_LABEL_KEYS[status] ?? 'db.status.idle')}</span>
        {isRedis && status === 'connected' && viewSwitcher(
          ['keys', 'pubsub', 'console'], redisView, (view) => setRedisView(view as 'keys' | 'pubsub' | 'console'),
          (view) => t(`db.workbench.view.${view}`),
        )}
        {!isRedis && status === 'connected' && viewSwitcher(
          ['workbench', 'backup'], sqlView, (view) => setSqlView(view as 'workbench' | 'backup'),
          (view) => t(view === 'backup' ? 'db.backup.title' : `db.workbench.view.${view}`),
        )}
        {isRedis && !isCluster && status === 'connected' && dbOptions && (
          <Select value={String(currentDb)} onValueChange={(v) => void switchDb(Number(v))}>
            <SelectTrigger className="h-7 w-[150px] text-xs ml-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-64">
              {dbOptions.map((option) => (
                <SelectItem key={option.db} value={String(option.db)} className="text-xs">
                  db{option.db}{option.keys > 0 ? ` · ${option.keys}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="ml-auto flex items-center gap-1">
          {status === 'connected' && (
            <>
              <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('db.action.refresh')}
                onClick={() => setRefreshToken((v) => v + 1)}>
                <RefreshCw size={13} />
              </Button>
              <Button variant="outline" size="sm" onClick={disconnect}>{t('db.action.disconnect')}</Button>
            </>
          )}
          {(status === 'idle' || status === 'error' || status === 'disconnected') && (
            <Button variant="outline" size="sm" onClick={connect}>
              <PlugZap size={13} className="mr-1" />{status === 'error' ? t('db.error.retry') : t('db.action.reconnect')}
            </Button>
          )}
        </div>
      </div>
      {status === 'error' && errorMessage && (
        <div className="px-3 py-2 text-xs text-destructive border-b border-border/60">
          <span className="font-medium">{t('db.error.title')}: </span>{errorMessage}
        </div>
      )}
      {connectionId ? (
        isRedis && redisView === 'pubsub' ? (
          <RedisPubSub connectionId={connectionId} />
        ) : isRedis && redisView === 'console' ? (
          <RedisConsole connectionId={connectionId} />
        ) : !isRedis && sqlView === 'backup' ? (
          // Backup/restore: full-area view like the redis console views.
          <SqlBackupRestore
            connectionId={connectionId}
            dialect={sqlDialect}
            table={selectedTable ?? undefined}
            schema={selectedSchema}
            dbName={host.sqlConfig?.database || host.hostname}
            onClose={() => setSqlView('workbench')}
          />
        ) : !isRedis && designerOpen ? (
          // Visual table designer: full-area view like the redis console views.
          <SqlTableDesigner
            connectionId={connectionId}
            dialect={sqlDialect}
            schema={selectedSchema}
            editingTable={designerTable}
            onClose={() => setDesignerOpen(false)}
            onDone={designerDone}
          />
        ) : (
        <div className="flex-1 min-h-0 grid grid-cols-[260px_minmax(0,1fr)]">
          <div className="border-r border-border/60 min-h-0 flex flex-col">
            {isRedis ? (
              <RedisKeyTree
                connectionId={connectionId}
                db={currentDb}
                refreshToken={refreshToken}
                clusterNodes={clusterNodes}
                clusterMode={isCluster}
                onSelectKey={(key, nodeId) => { setSelectedKey(key); setSelectedNodeId(nodeId); }}
                onKeysChanged={bumpRedisRefresh}
              />
            ) : (
              <SqlSchemaTree
                connectionId={connectionId}
                dialect={sqlDialect}
                refreshToken={refreshToken}
                onCreateTable={() => openDesigner(null)}
                onSelectTable={(table, _kind, schema) => { setSelectedTable(table); setSelectedSchema(schema); setSqlTab('data'); }}
                selectedDatabase={selectedDatabase}
                onSelectDatabase={selectDatabase}
                dbMenu={dbMenu}
                tableMenu={tableMenu}
                viewMenu={viewMenu}
              />
            )}
          </div>
          <div className="min-h-0 flex flex-col">
            {isRedis ? (
              selectedKey ? (
                <RedisValueViewer
                  connectionId={connectionId}
                  selectedKey={selectedKey}
                  nodeId={selectedNodeId}
                  refreshToken={refreshToken}
                  onKeysChanged={() => { setSelectedKey(null); bumpRedisRefresh(); }}
                  onKeyRenamed={(newKey) => { setSelectedKey(newKey); bumpRedisRefresh(); }}
                />
              ) : (
                // No key selected: the default view shows the server overview
                // (stats from the shared serverInfo fetch) instead of blank space.
                <RedisOverviewPanel summary={redisSummary ?? {}} db={currentDb} />
              )
            ) : (
              <>
                <div className="px-3 pt-2 flex gap-1 border-b border-border/60 shrink-0">
                  {(['structure', 'data', 'query'] as const).map((tab) => (
                    <button key={tab} type="button"
                      className={`px-3 py-1.5 text-xs rounded-t ${sqlTab === tab ? 'bg-foreground/10 text-foreground font-medium' : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'}`}
                      onClick={() => setSqlTab(tab)}>
                      {t(`db.workbench.tab.${tab}`)}
                    </button>
                  ))}
                </div>
                <div className="flex-1 min-h-0">
                  {sqlTab === 'data' ? (
                    <SqlTableData
                      connectionId={connectionId}
                      dialect={sqlDialect}
                      table={selectedTable}
                      schema={selectedSchema}
                      refreshToken={refreshToken}
                      jumpFilter={jumpFilter}
                      jumpCounter={jumpCounter}
                      onNavigateForeignKey={navigateForeignKey}
                    />
                  ) : sqlTab === 'structure' ? (
                    <SqlTableStructure
                      connectionId={connectionId}
                      dialect={sqlDialect}
                      table={selectedTable}
                      schema={selectedSchema}
                      refreshToken={refreshToken}
                      onEditTable={selectedTable ? () => openDesigner(selectedTable) : undefined}
                    />
                  ) : (
                    <SqlQueryEditor
                      connectionId={connectionId}
                      sessionId={session.id}
                      dialect={sqlDialect}
                      seedQuery={querySeed}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        </div>
        )
      ) : (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          {t('db.workbench.noSelection')}
        </div>
      )}
      {treeConfirm && (
        <ConfirmDialog
          open
          title={treeConfirm.title}
          message={treeConfirm.message}
          confirmLabel={treeConfirm.confirmLabel}
          destructive
          busy={treeActionBusy}
          onOpenChange={(open) => { if (!open) setTreeConfirm(null); }}
          onConfirm={() => { void runTreeSql(treeConfirm.sql).then(() => setTreeConfirm(null)); }}
        />
      )}
      {renameTarget && (
        <PromptDialog
          open
          title={t('db.tree.menu.renameTitle', { name: renameTarget.object })}
          label={t('db.tree.menu.newName')}
          initialValue={renameTarget.object}
          confirmLabel={t('common.rename')}
          busy={renameBusy}
          onOpenChange={(open) => { if (!open) setRenameTarget(null); }}
          onConfirm={(value) => void confirmRename(value)}
        />
      )}
    </div>
  );
};

export default DatabaseWorkbench;
