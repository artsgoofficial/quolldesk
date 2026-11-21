import Editor, { type OnMount, useMonaco } from '@monaco-editor/react';
import { ChevronDown, ChevronUp, Download, History, Play, Plus, Sparkles, Star, Trash2, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
// The @/ alias is the repo's sanctioned path for component-layer imports of
// infrastructure services (relative ../../infrastructure imports are eslint-restricted).
import { databaseClient, dbErrorMessage } from '@/infrastructure/services/databaseClient';
import { useQuollDeskMonacoTheme } from '@/infrastructure/monaco/useQuollDeskMonacoTheme';
import { configureMonacoLoader } from '@/infrastructure/monaco/monacoLoader';
import {
  attachSqlValidation,
  registerSqlCompletionProviders,
  setSqlEditorContext,
  SqlSchemaCatalog,
  type SqlEditorContext,
} from '@/infrastructure/monaco/sqlIntellisense';
import { localStorageAdapter } from '@/infrastructure/persistence/localStorageAdapter';
import {
  STORAGE_KEY_DB_QUERY_FAVORITES,
  STORAGE_KEY_DB_QUERY_HISTORY,
} from '@/infrastructure/config/storageKeys';
import { fetchSqlSchemaTree } from '@/infrastructure/services/sqlSchemaTreeCache';
import type { SqlResultSet } from '../../types/global/quolldesk-bridge-database';
import { emitAiPrompt, requestAiPanelOpen, subscribeSqlEditorAction } from '../../application/state/sqlEditorBridge';
import { Button } from '../ui/button';
import { Dropdown, DropdownContent, DropdownTrigger } from '../ui/dropdown';
import { toast } from '../ui/toast';
import { downloadCsv, downloadInserts, downloadJson } from './csv';
import { splitSqlStatements } from './splitSqlStatements';

interface SqlQueryEditorProps {
  connectionId: string;
  /** Workbench tab session id — used to open the native AI side panel. */
  sessionId: string;
  dialect: 'mysql' | 'postgresql';
  /** Tree "新建查询" seeding: when token changes, open a new tab with sql. */
  seedQuery?: { sql: string; token: number };
}

interface QueryTab { id: string; name: string; sql: string }

/** One query result set — the bridge wire contract (SqlResultSet). */
type ResultSet = SqlResultSet;

/** Result of one executed statement — multi-statement scripts get one entry each. */
interface StatementResult {
  sql: string;
  resultSets: ResultSet[] | null;
  executionTimeMs: number | null;
  truncated: boolean;
  error: string | null;
}

/**
 * Per-tab result state; entries are dropped when the tab is closed. Statements
 * run sequentially (stop at the first error), so each keeps its own outcome
 * and the results area shows one tab per statement.
 */
interface TabResult {
  statements: StatementResult[];
  activeStatement: number;
  totalMs: number | null;
  truncated: boolean;
}

/**
 * Per-tab EXPLAIN panel state. mysql keeps the plan as a compact table
 * (resultSets); pg plans arrive as one text line per row and are concatenated
 * into `text`. Row/cell caps come from the bridge (1000 rows / 4KB cells).
 */
interface ExplainState {
  open: boolean;
  loading: boolean;
  error: string | null;
  resultSets: ResultSet[] | null;
  text: string | null;
}

const EMPTY_EXPLAIN: ExplainState = { open: false, loading: false, error: null, resultSets: null, text: null };

/** Query history / favorites persisted per dialect, most recent first. */
interface DialectQueryLists { mysql: string[]; postgresql: string[] }

const QUERY_LIST_CAP = 50;
const EMPTY_QUERY_LISTS: DialectQueryLists = { mysql: [], postgresql: [] };

configureMonacoLoader();

// monaco basic-languages ships both ids (mysql -> sql, postgresql -> pgsql).
const dialectToMonacoLanguage = (dialect: 'mysql' | 'postgresql') => (dialect === 'mysql' ? 'sql' : 'pgsql');

const createTabId = (): string =>
  `qtab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Compact statement-tab label (collapsed snippet); the title attr carries the full text. */
const statementLabel = (sql: string): string => {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
};

const readQueryLists = (storageKey: string): DialectQueryLists => {
  const stored = localStorageAdapter.read<DialectQueryLists>(storageKey);
  if (!stored || !Array.isArray(stored.mysql) || !Array.isArray(stored.postgresql)) return EMPTY_QUERY_LISTS;
  const keepStrings = (items: unknown[]) => items.filter((item): item is string => typeof item === 'string');
  return { mysql: keepStrings(stored.mysql), postgresql: keepStrings(stored.postgresql) };
};

/** Read-modify-write one dialect's persisted query list (history/favorites). */
const updateQueryList = (
  storageKey: string,
  current: DialectQueryLists,
  dialectKey: 'mysql' | 'postgresql',
  update: (items: string[]) => string[],
): DialectQueryLists => {
  const next: DialectQueryLists = { ...current, [dialectKey]: update(current[dialectKey]) };
  localStorageAdapter.write(storageKey, next);
  return next;
};

const SqlQueryEditor: React.FC<SqlQueryEditorProps> = ({ connectionId, sessionId, dialect, seedQuery }) => {
  const { t } = useI18n();
  const monaco = useMonaco();
  const themeName = useQuollDeskMonacoTheme(monaco);
  const client = databaseClient[dialect];
  // Multi-tab query editing: every tab keeps its own SQL, switching preserves it.
  const nextTabNumberRef = useRef(1);
  const [tabs, setTabs] = useState<QueryTab[]>(() =>
    [{ id: createTabId(), name: t('db.query.tab', { n: 1 }), sql: '' }]);
  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0].id);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  // Results are keyed by tab id so each tab restores its own result set on switch.
  const [resultsByTab, setResultsByTab] = useState<Record<string, TabResult>>({});
  const [runningTabId, setRunningTabId] = useState<string | null>(null);
  // Query history and favorites persist per dialect via localStorageAdapter.
  const [history, setHistory] = useState<DialectQueryLists>(() => readQueryLists(STORAGE_KEY_DB_QUERY_HISTORY));
  const [favorites, setFavorites] = useState<DialectQueryLists>(() => readQueryLists(STORAGE_KEY_DB_QUERY_FAVORITES));
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<'history' | 'favorites'>('history');
  const [exportOpen, setExportOpen] = useState(false);
  // Last query error (AI 修复 button enablement + prompt payload).
  const [lastError, setLastError] = useState<string | null>(null);
  // Editor instance for selection reads (AI 优化 uses the selected range).
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const activeResult = resultsByTab[activeTab.id];
  // Guard the index against a re-run that produced fewer statements than the
  // previous one; entries are absent while a run is still publishing.
  const activeEntry = activeResult && activeResult.statements.length > 0
    ? activeResult.statements[Math.min(activeResult.activeStatement, activeResult.statements.length - 1)]
    : null;
  const multiStatement = (activeResult?.statements.length ?? 0) > 1;
  const historyItems = history[dialect];
  const favoriteItems = favorites[dialect];
  const running = runningTabId != null;

  const setSql = useCallback((next: string) => {
    setTabs((prev) => prev.map((tab) => (tab.id === activeTabId ? { ...tab, sql: next } : tab)));
  }, [activeTabId]);

  const run = useCallback(async () => {
    const tabId = activeTabId;
    const sql = tabs.find((tab) => tab.id === tabId)?.sql ?? '';
    if (runningTabId != null || !sql.trim()) return;
    // Statements run one by one so each SQL gets its own result tab; stop at
    // the first error, keeping earlier statements' results visible.
    const statements = splitSqlStatements(sql, dialect);
    if (!statements.length) return;
    setRunningTabId(tabId);
    setResultsByTab((prev) => ({
      ...prev,
      [tabId]: { statements: [], activeStatement: 0, totalMs: null, truncated: false },
    }));
    const entries: StatementResult[] = [];
    // Publish the entries so far (progressive rendering while the script runs);
    // the last entry — the failed one when stopped — becomes the active tab.
    const store = () => {
      setResultsByTab((prev) => ({
        ...prev,
        [tabId]: {
          statements: [...entries],
          activeStatement: Math.max(0, entries.length - 1),
          totalMs: entries.reduce((sum, entry) => sum + (entry.executionTimeMs ?? 0), 0),
          truncated: entries.some((entry) => entry.truncated),
        },
      }));
    };
    let failed = false;
    try {
      for (const statement of statements) {
        try {
          const result = await client.query({ connectionId, sql: statement });
          entries.push({
            sql: statement,
            resultSets: result.resultSets,
            executionTimeMs: result.executionTimeMs,
            truncated: result.truncated,
            error: null,
          });
          store();
        } catch (err) {
          const message = dbErrorMessage(err);
          entries.push({ sql: statement, resultSets: null, executionTimeMs: null, truncated: false, error: message });
          store();
          setLastError(message);
          failed = true;
          break;
        }
      }
      if (!failed) {
        setHistory((prev) => updateQueryList(
          STORAGE_KEY_DB_QUERY_HISTORY, prev, dialect,
          (items) => [sql, ...items.filter((item) => item !== sql)].slice(0, QUERY_LIST_CAP),
        ));
        setHistoryPanelOpen(false);
        setLastError(null);
      }
    } finally {
      setRunningTabId(null);
    }
  }, [activeTabId, client, connectionId, dialect, runningTabId, tabs]);

  const runRef = useRef(run);
  useEffect(() => { runRef.current = run; }, [run]);

  // SQL intellisense context, shared with the completion providers through a
  // mutable object so a refreshed schemaTree reaches them without re-registering.
  const sqlContextRef = useRef<SqlEditorContext>({ dialect, catalog: null });
  const validationDisposableRef = useRef<{ dispose: () => void } | null>(null);
  useEffect(() => {
    sqlContextRef.current.dialect = dialect;
  }, [dialect]);

  // Schema tables/columns for completions; failures degrade to keyword-only hints.
  useEffect(() => {
    if (!connectionId) return;
    let alive = true;
    // Shared cache with SqlSchemaTree: one fetch serves both consumers, and
    // remounting this editor (per tab switch) reuses the snapshot.
    fetchSqlSchemaTree(dialect, connectionId)
      .then((tree) => {
        if (!alive) return;
        sqlContextRef.current.catalog = new SqlSchemaCatalog({
          dialect,
          databases: tree.databases,
          fetchColumns: (args) => client.tableMeta({ connectionId, ...args })
            .then((meta) => meta.columns.map(({ name, type }) => ({ name, type }))),
        });
      })
      .catch(() => {
        if (alive) sqlContextRef.current.catalog = null;
      });
    return () => { alive = false; };
  }, [connectionId, dialect, client]);

  const [explainByTab, setExplainByTab] = useState<Record<string, ExplainState>>({});
  const activeExplain = explainByTab[activeTab.id];

  // EXPLAIN guard: exactly one SELECT/WITH statement. A trailing ";" is
  // stripped (cosmetic), but any embedded ";" means a multi-statement script —
  // EXPLAIN-ing those would execute the extra statements for real.
  const activeSqlTrimmed = activeTab.sql.trim().replace(/;\s*$/, '');
  const explainable = /^(select|with)\b/i.test(activeSqlTrimmed) && !activeSqlTrimmed.includes(';');

  const runExplain = useCallback(async () => {
    const tabId = activeTabId;
    const raw = tabs.find((tab) => tab.id === tabId)?.sql ?? '';
    const trimmed = raw.trim().replace(/;\s*$/, '');
    if (runningTabId != null) return;
    if (!trimmed || !/^(select|with)\b/i.test(trimmed) || trimmed.includes(';')) {
      toast.info(t('db.query.explainOnlySelect'));
      return;
    }
    setExplainByTab((prev) => ({
      ...prev,
      [tabId]: { ...(prev[tabId] ?? EMPTY_EXPLAIN), open: true, loading: true, error: null },
    }));
    try {
      const sql = `EXPLAIN ${trimmed}`;
      const result = await client.query({ connectionId, sql });
      // pg: EXPLAIN returns one text line per row — concatenate for <pre>.
      const text = dialect === 'postgresql'
        ? result.resultSets.map((rs) => rs.rows.map((row) => String(row?.[0] ?? '')).join('\n')).join('\n\n')
        : null;
      setExplainByTab((prev) => ({
        ...prev,
        [tabId]: { open: true, loading: false, error: null, resultSets: result.resultSets, text },
      }));
    } catch (err) {
      const message = dbErrorMessage(err);
      setExplainByTab((prev) => ({
        ...prev,
        [tabId]: { open: true, loading: false, error: message, resultSets: null, text: null },
      }));
    }
  }, [activeTabId, client, connectionId, dialect, runningTabId, t, tabs]);

  const closeExplain = (tabId: string) => {
    setExplainByTab((prev) => {
      if (!(tabId in prev)) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
  };

  const addToFavorites = (query: string) => {
    setFavorites((prev) => updateQueryList(
      STORAGE_KEY_DB_QUERY_FAVORITES, prev, dialect,
      (items) => [query, ...items.filter((item) => item !== query)].slice(0, QUERY_LIST_CAP),
    ));
  };

  const removeFromFavorites = (query: string) => {
    setFavorites((prev) => updateQueryList(
      STORAGE_KEY_DB_QUERY_FAVORITES, prev, dialect,
      (items) => items.filter((item) => item !== query),
    ));
  };

  const addTab = () => {
    nextTabNumberRef.current += 1;
    const tab: QueryTab = { id: createTabId(), name: t('db.query.tab', { n: nextTabNumberRef.current }), sql: '' };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  };

  // Tree "新建查询" seeding: the workbench bumps token when a schema-tree
  // context menu asks for a query tab (the editor then mounts on the query
  // tab with seedQuery). A remount carrying the same token must NOT seed
  // again (tab switches unmount this component) — only a bumped token seeds.
  const seededTokenRef = useRef<number | null>(null);
  useEffect(() => {
    if (!seedQuery) return;
    const firstSeed = seededTokenRef.current === null;
    const tokenChanged = !firstSeed && seedQuery.token !== seededTokenRef.current;
    if (!firstSeed && !tokenChanged) return;
    seededTokenRef.current = seedQuery.token;
    nextTabNumberRef.current += 1;
    const tab: QueryTab = { id: createTabId(), name: t('db.query.tab', { n: nextTabNumberRef.current }), sql: seedQuery.sql };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }, [seedQuery, t]);

  const closeTab = (tabId: string) => {
    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1 || tabs.length <= 1) return;
    const next = tabs.filter((tab) => tab.id !== tabId);
    setTabs(next);
    if (tabId === activeTabId) setActiveTabId(next[Math.min(index, next.length - 1)].id);
    setResultsByTab((prev) => {
      if (!(tabId in prev)) return prev;
      const nextResults = { ...prev };
      delete nextResults[tabId];
      return nextResults;
    });
    setExplainByTab((prev) => {
      if (!(tabId in prev)) return prev;
      const nextExplain = { ...prev };
      delete nextExplain[tabId];
      return nextExplain;
    });
  };

  const startRename = (tab: QueryTab) => {
    setRenamingTabId(tab.id);
    setRenameDraft(tab.name);
  };

  const commitRename = () => {
    if (renamingTabId) {
      const name = renameDraft.trim();
      if (name) setTabs((prev) => prev.map((tab) => (tab.id === renamingTabId ? { ...tab, name } : tab)));
    }
    setRenamingTabId(null);
  };

  // In-editor shortcut (monaco swallows keydown, so it must be an editor command).
  // Completion providers register once per monaco instance (app-lifetime, keyed
  // per model via setSqlEditorContext); validation is per-editor and disposed.
  const handleEditorMount: OnMount = useCallback((editor, monacoInstance) => {
    editorRef.current = editor;
    editor.addCommand(
      monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.Enter,
      () => runRef.current(),
    );
    registerSqlCompletionProviders(monacoInstance);
    const model = editor.getModel();
    if (model) setSqlEditorContext(model, sqlContextRef.current);
    // Language switches recreate the model — rebind the context (the editor's
    // model is already the new one by the time this fires).
    editor.onDidChangeModel(() => {
      const model = editor.getModel();
      if (model) setSqlEditorContext(model, sqlContextRef.current);
    });
    validationDisposableRef.current = attachSqlValidation(editor, monacoInstance, () => sqlContextRef.current);
  }, []);

  useEffect(() => () => {
    validationDisposableRef.current?.dispose();
    validationDisposableRef.current = null;
    editorRef.current = null;
  }, []);

  // AI panel → editor: apply insert/replace actions emitted by the assistant's
  // SQL message actions. Scoped by connectionId when the emitter set one.
  useEffect(() => subscribeSqlEditorAction((action) => {
    if (action.connectionId && action.connectionId !== connectionId) return;
    if (action.kind === 'replace') {
      setSql(action.sql);
    } else {
      setSql((activeTab.sql ? `${activeTab.sql}\n\n` : '') + action.sql);
    }
  }), [activeTab.sql, connectionId, setSql]);

  // Editor → AI: open the framework-native AI side panel for this tab and
  // prefill the composer with an optimize/fix prompt (scoped to this
  // connection; the database panel consumes matching prompts only).
  const emitOptimize = useCallback(() => {
    const editor = editorRef.current;
    const selection = editor?.getSelection();
    const model = editor?.getModel();
    const selected = selection && model ? model.getValueInRange(selection) : '';
    const sql = (selected.trim() || activeTab.sql.trim());
    if (!sql) return;
    requestAiPanelOpen({ sessionId });
    emitAiPrompt({ text: t('db.ai.prompt.optimize').replace('{sql}', sql), connectionId });
  }, [activeTab.sql, connectionId, sessionId, t]);

  const emitFix = useCallback(() => {
    const sql = activeTab.sql.trim();
    if (!sql || !lastError) return;
    requestAiPanelOpen({ sessionId });
    emitAiPrompt({ text: t('db.ai.prompt.fix').replace('{sql}', sql).replace('{error}', lastError), connectionId });
  }, [activeTab.sql, connectionId, lastError, sessionId, t]);

  // Container fallback so the shortcut also works when focus is outside the
  // editor but inside this component (e.g. on the Run button).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void runRef.current(); }
  };

  // First result set of the active statement (drives the export dropdown).
  const current = activeEntry?.resultSets?.[0] ?? null;

  const renderExportItem = (label: string, onPick: () => void) => (
    <Button variant="ghost" className="w-full justify-start h-8"
      onClick={() => { onPick(); setExportOpen(false); }}>
      {label}
    </Button>
  );

  // One history/favorites row: click loads the query, side action stars or
  // removes it (same list markup, different action icon/color).
  const renderQueryItem = (
    item: string, index: number, keyPrefix: string,
    actionIcon: React.ReactNode, actionTitle: string, actionClass: string, onAction: () => void,
  ) => (
    <div key={`${keyPrefix}-${index}`} className="flex items-center gap-1">
      <button type="button"
        className="flex-1 min-w-0 text-left px-2 py-1 rounded text-xs font-mono truncate hover:bg-foreground/5 text-muted-foreground"
        title={item}
        onClick={() => { setSql(item); setHistoryPanelOpen(false); }}>
        {item.replace(/\s+/g, ' ').slice(0, 120)}
      </button>
      <button type="button"
        className={`p-1 rounded text-muted-foreground shrink-0 ${actionClass}`}
        title={actionTitle}
        onClick={onAction}>
        {actionIcon}
      </button>
    </div>
  );

  return (
    <div className="flex flex-col h-full min-h-0" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-1 px-2 pt-1 overflow-x-auto">
        {tabs.map((tab) => (
          <div key={tab.id}
            className={`group flex items-center gap-1 pl-2 pr-1 py-1 rounded-t text-xs max-w-[200px] shrink-0 ${tab.id === activeTabId ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:bg-foreground/5'}`}>
            {renamingTabId === tab.id ? (
              <input autoFocus value={renameDraft} size={Math.max(4, renameDraft.length)}
                className="bg-transparent outline-none text-xs min-w-0"
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setRenamingTabId(null);
                }} />
            ) : (
              <button type="button" className="truncate" title={tab.name}
                onClick={() => setActiveTabId(tab.id)}
                onDoubleClick={() => startRename(tab)}>
                {tab.name}
              </button>
            )}
            {tabs.length > 1 && (
              <button type="button"
                className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-foreground/10 shrink-0"
                title={t('db.action.close')}
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}>
                <X size={11} />
              </button>
            )}
          </div>
        ))}
        <button type="button" className="p-1 rounded text-muted-foreground hover:bg-foreground/5 shrink-0"
          title={t('db.query.addTab')} onClick={addTab}>
          <Plus size={12} />
        </button>
      </div>
      <div className="p-2 border-b border-border/60 flex items-start gap-2">
        <div className="flex-1 h-36 min-w-0 relative">
          <Editor
            height="100%"
            language={dialectToMonacoLanguage(dialect)}
            value={activeTab.sql}
            onChange={(next) => setSql(next ?? '')}
            onMount={handleEditorMount}
            theme={themeName}
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              lineNumbers: 'on',
              wordWrap: 'on',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              insertSpaces: true,
              renderLineHighlight: 'line',
              padding: { top: 6, bottom: 6 },
              folding: false,
              contextmenu: false,
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Button size="sm" className="font-medium" disabled={running || !activeTab.sql.trim()} onClick={() => void run()}>
            <Play size={13} className="mr-1" />{t('db.workbench.query.run')}
          </Button>
          <Button variant="outline" size="sm"
            disabled={running || !activeTab.sql.trim() || !explainable}
            title={explainable ? t('db.query.explain') : t('db.query.explainOnlySelect')}
            onClick={() => void runExplain()}>
            {t('db.query.explain')}
          </Button>
          <Button variant="outline" size="sm"
            disabled={!activeTab.sql.trim()}
            title={t('db.ai.optimize')}
            onClick={emitOptimize}>
            <Sparkles size={13} className="mr-1" />{t('db.ai.optimize')}
          </Button>
          <Button variant="outline" size="sm"
            disabled={!lastError || !activeTab.sql.trim()}
            title={lastError ? t('db.ai.fix') : t('db.ai.fix')}
            onClick={emitFix}>
            <Sparkles size={13} className="mr-1" />{t('db.ai.fix')}
          </Button>
          <Button variant="outline" size="sm"
            disabled={historyItems.length === 0 && favoriteItems.length === 0}
            onClick={() => setHistoryPanelOpen((v) => !v)}>
            <History size={13} className="mr-1" />{t('db.query.history')}
          </Button>
        </div>
      </div>
      {activeExplain && (
        <div className="border-b border-border/60 flex flex-col max-h-56">
          <div className="px-3 py-1 flex items-center gap-1 shrink-0">
            <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setExplainByTab((prev) => ({
                ...prev,
                [activeTab.id]: { ...(prev[activeTab.id] ?? EMPTY_EXPLAIN), open: !(prev[activeTab.id]?.open ?? false) },
              }))}>
              {activeExplain.open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {t('db.query.explain')}
            </button>
            {activeExplain.loading && <span className="text-xs text-muted-foreground animate-pulse">…</span>}
            {activeExplain.error && <span className="text-xs text-destructive truncate">{activeExplain.error}</span>}
            <button type="button" className="ml-auto p-1 rounded text-muted-foreground hover:text-foreground hover:bg-foreground/5"
              title={t('db.action.close')} onClick={() => closeExplain(activeTab.id)}>
              <X size={12} />
            </button>
          </div>
          {activeExplain.open && (
            <div className="flex-1 min-h-0 overflow-auto px-3 pb-2">
              {dialect === 'postgresql' ? (
                <pre className="text-xs font-mono whitespace-pre-wrap break-words text-muted-foreground">{activeExplain.text}</pre>
              ) : (
                (() => {
                  const plan = activeExplain.resultSets?.[0];
                  if (!plan) return null;
                  return (
                    <table className="w-full border-collapse text-xs">
                      <thead className="sticky top-0 bg-background">
                        <tr className="border-b border-border/60">
                          {plan.columns.map((c) => (
                            <th key={c.name} className="px-2 py-1 text-left font-medium text-muted-foreground">{c.name}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {plan.rows.map((row, i) => (
                          <tr key={`explain-row-${i}`} className="border-b border-border/30 hover:bg-foreground/5">
                            {row.map((cell, j) => (
                              <td key={`explain-cell-${j}`} className="px-2 py-1 font-mono truncate max-w-[320px]" title={cell == null ? undefined : String(cell)}>
                                {cell == null ? <span className="text-muted-foreground italic">NULL</span> : String(cell)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  );
                })()
              )}
            </div>
          )}
        </div>
      )}
      {historyPanelOpen && (
        <div className="px-2 pb-2 border-b border-border/60 max-h-40 overflow-auto">
          <div className="flex gap-1 py-1">
            <button type="button"
              className={`px-2 py-0.5 rounded text-xs ${panelMode === 'history' ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:bg-foreground/5'}`}
              onClick={() => setPanelMode('history')}>
              {t('db.query.history')} ({historyItems.length})
            </button>
            <button type="button"
              className={`px-2 py-0.5 rounded text-xs ${panelMode === 'favorites' ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:bg-foreground/5'}`}
              onClick={() => setPanelMode('favorites')}>
              {t('db.query.favorites')} ({favoriteItems.length})
            </button>
          </div>
          {panelMode === 'history' && historyItems.map((item, i) => renderQueryItem(
            item, i, 'h', <Star size={12} />, t('db.query.favorites'),
            'hover:text-foreground hover:bg-foreground/5', () => addToFavorites(item),
          ))}
          {panelMode === 'favorites' && favoriteItems.map((item, i) => renderQueryItem(
            item, i, 'f', <Trash2 size={12} />, t('db.action.delete'),
            'hover:text-destructive hover:bg-foreground/5', () => removeFromFavorites(item),
          ))}
        </div>
      )}
      {activeEntry?.error && <p className="text-destructive text-xs px-3 py-2 whitespace-pre-wrap">{activeEntry.error}</p>}
      {multiStatement && activeResult && (
        <div className="px-3 pt-2 flex gap-1 flex-wrap">
          {activeResult.statements.map((entry, i) => (
            <button key={`stmt-${i}`} type="button"
              title={entry.sql}
              className={`px-2 py-0.5 rounded text-xs max-w-[220px] truncate ${entry.error ? 'bg-destructive/10 text-destructive' : i === activeResult.activeStatement ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:bg-foreground/5'}`}
              onClick={() => setResultsByTab((prev) => {
                const existing = prev[activeTab.id];
                if (!existing) return prev;
                return { ...prev, [activeTab.id]: { ...existing, activeStatement: i } };
              })}>
              {statementLabel(entry.sql)}
            </button>
          ))}
        </div>
      )}
      {activeEntry?.resultSets && current && (
        <div className="flex-1 overflow-auto">
          <div className="px-3 pt-2">
            <Dropdown open={exportOpen} onOpenChange={setExportOpen}>
              <DropdownTrigger asChild>
                <Button variant="outline" size="sm" className="h-6">
                  <Download size={12} className="mr-1" />{t('db.grid.export')}<ChevronDown size={11} className="ml-1" />
                </Button>
              </DropdownTrigger>
              <DropdownContent align="start">
                {renderExportItem(t('db.grid.exportCsv'), () =>
                  downloadCsv('query-result.csv', current.columns.map((c) => c.name), current.rows))}
                {renderExportItem(t('db.export.json'), () =>
                  downloadJson('query-result.json', current.columns.map((c) => c.name), current.rows))}
                {renderExportItem(t('db.export.inserts'), () =>
                  downloadInserts('query-result.sql', 'query_result', current.columns.map((c) => c.name), current.rows))}
              </DropdownContent>
            </Dropdown>
          </div>
          {activeEntry.resultSets.map((rs, index) => (
            <div key={`result-${index}`} className={index > 0 ? 'mt-3' : ''}>
              {activeEntry.resultSets!.length > 1 && (
                <p className="text-xs text-muted-foreground px-3 pt-1">{t('db.workbench.query.results')} #{index + 1}</p>
              )}
              <table className="w-full border-collapse text-xs mt-1">
                <thead className="sticky top-0 bg-background">
                  <tr className="border-b border-border/60">
                    <th className="px-2 py-1 text-left font-medium text-muted-foreground">#</th>
                    {rs.columns.map((c) => <th key={c.name} className="px-2 py-1 text-left font-medium">{c.name}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rs.rows.map((row, i) => (
                    <tr key={`row-${i}`} className="border-b border-border/30 hover:bg-foreground/5">
                      <td className="px-2 py-1 text-muted-foreground">{i + 1}</td>
                      {row.map((cell, j) => (
                        <td key={`cell-${j}`} className="px-2 py-1 font-mono truncate max-w-[320px]" title={cell == null ? undefined : String(cell)}>{cell == null ? <span className="text-muted-foreground italic">NULL</span> : String(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {rs.rows.length === 0 && rs.affectedRows != null && (
                <p className="text-xs text-muted-foreground px-3 py-2">{t('db.workbench.query.affected', { count: rs.affectedRows })}</p>
              )}
            </div>
          ))}
        </div>
      )}
      {activeResult && (activeResult.totalMs != null || activeResult.truncated) && (
        <div className="px-3 py-1 border-t border-border/60 text-xs text-muted-foreground flex gap-3">
          {activeResult.totalMs != null && <span>{t('db.workbench.executionTime', { ms: activeResult.totalMs })}</span>}
          {activeResult.truncated && <span className="text-amber-500">{t('db.workbench.truncated')}</span>}
        </div>
      )}
    </div>
  );
};

export default SqlQueryEditor;
