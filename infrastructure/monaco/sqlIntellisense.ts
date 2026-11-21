import type { Monaco } from '@monaco-editor/react';

/**
 * SQL intellisense for the database query editors, backed by dt-sql-parser
 * (dialect ANTLR parsers — MySQL + PostgreSQL). Three pieces:
 *
 * 1. Pure core: `computeSqlSuggestions` (parser caret suggestions + schema
 *    catalog) and `toMonacoMarkers` (validate() → marker mapping).
 * 2. `SqlSchemaCatalog`: schemaTree tables/views plus lazily fetched columns
 *    per table (columns come from the bridge via an injected fetcher, so this
 *    module stays decoupled from databaseClient).
 * 3. Monaco glue: completion providers for language ids 'sql'/'pgsql' and a
 *    debounced validation attachment (red squiggles).
 */

export type SqlDialect = 'mysql' | 'postgresql';

/** Structural slice of a dt-sql-parser parser instance (MySQL / PostgreSQL). */
export interface SqlParserLike {
  getSuggestionAtCaretPosition(
    sql: string,
    position: { lineNumber: number; column: number },
  ): { keywords?: string[]; syntax?: { syntaxContextType: string; wordRanges?: { text: string }[] }[] } | undefined;
  validate(sql: string): { startLine: number; startColumn: number; endLine: number; endColumn: number; message: string }[];
  getAllEntities(sql: string): { entityContextType: string; text: string }[];
}

export interface SqlSuggestion {
  label: string;
  kind: 'keyword' | 'table' | 'view' | 'column';
  /** Column type for columns; owning database/schema for qualified table names. */
  detail?: string;
}

/** One dt-sql-parser validation error, 1-based line/column. */
export interface SqlValidationError {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  message: string;
}

export interface SqlSchemaDatabase {
  name: string;
  tables: string[];
  views: string[];
}

export type SqlColumnFetcher = (args: { schema?: string; table: string }) => Promise<{ name: string; type: string }[]>;

/** Marker severity 8 is Monaco's MarkerSeverity.Error. */
export interface MonacoMarkerLike {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  message: string;
  severity: 8;
}

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

/**
 * Suggestions for the caret position. Parser keyword candidates always come
 * through (Monaco filters by typed prefix); schema items are added when the
 * caret sits in a table/view context (FROM/JOIN) or a column context
 * (WHERE / SELECT list with tables referenced in the statement).
 */
export async function computeSqlSuggestions(input: {
  parser: SqlParserLike;
  text: string;
  position: { lineNumber: number; column: number };
  catalog: SqlSchemaCatalog | null;
  dialect: SqlDialect;
}): Promise<SqlSuggestion[]> {
  const { parser, text, position, catalog } = input;
  let caret: ReturnType<SqlParserLike['getSuggestionAtCaretPosition']>;
  try {
    caret = parser.getSuggestionAtCaretPosition(text, position);
  } catch {
    caret = undefined;
  }
  const contextTypes = new Set((caret?.syntax ?? []).map((item) => item.syntaxContextType));

  const suggestions: SqlSuggestion[] = [];
  if (!catalog) return keywordSuggestions(caret);

  if (contextTypes.has('table') || contextTypes.has('view')) {
    suggestions.push(...catalog.tableSuggestions());
  } else if (contextTypes.has('column')) {
    const tableRefs = referencedTables(parser, text);
    if (tableRefs.length > 0) suggestions.push(...(await catalog.columnSuggestionsForRefs(tableRefs)));
  }
  suggestions.push(...keywordSuggestions(caret));
  return suggestions;
}

const keywordSuggestions = (caret: ReturnType<SqlParserLike['getSuggestionAtCaretPosition']>): SqlSuggestion[] =>
  (caret?.keywords ?? [])
    .filter((keyword): keyword is string => Boolean(keyword))
    .map((keyword) => ({ label: keyword, kind: 'keyword' as const }));

const referencedTables = (parser: SqlParserLike, text: string): string[] => {
  let entities: { entityContextType: string; text: string }[] = [];
  try {
    entities = parser.getAllEntities(text) ?? [];
  } catch {
    entities = [];
  }
  return [...new Set(entities.filter((entity) => entity.entityContextType === 'table').map((entity) => entity.text))];
};

/** dt-sql-parser 1-based line/column validation errors → Monaco error markers. */
export function toMonacoMarkers(errors: SqlValidationError[]): MonacoMarkerLike[] {
  return (errors ?? []).map((error) => ({
    startLineNumber: error.startLine,
    startColumn: error.startColumn,
    endLineNumber: error.endLine,
    endColumn: error.endColumn,
    message: error.message,
    severity: 8,
  }));
}

// ---------------------------------------------------------------------------
// Schema catalog
// ---------------------------------------------------------------------------

/**
 * Schema-aware suggestion source for one connection. Table/view names come
 * from a schemaTree snapshot; columns are fetched on first use and memoized
 * (the fetcher hits the database bridge via the caller).
 */
export class SqlSchemaCatalog {
  private readonly columnPromises = new Map<string, Promise<{ name: string; type: string }[]>>();
  // Table/view suggestions are static for the catalog's lifetime (the
  // schemaTree snapshot is fixed at construction) — build them once instead
  // of re-allocating the full list on every completion invocation.
  private tableSuggestionsCache: SqlSuggestion[] | null = null;

  constructor(
    private readonly options: {
      dialect: SqlDialect;
      databases: SqlSchemaDatabase[];
      fetchColumns: SqlColumnFetcher;
    },
  ) {}

  /** Tables/views from the schema tree; qualified `db.name` when multiple databases exist. */
  tableSuggestions(): SqlSuggestion[] {
    if (this.tableSuggestionsCache) return this.tableSuggestionsCache;
    const { databases } = this.options;
    const qualify = databases.length > 1;
    const suggestions: SqlSuggestion[] = [];
    for (const database of databases) {
      for (const table of database.tables) {
        suggestions.push({
          label: qualify ? `${database.name}.${table}` : table,
          kind: 'table',
          detail: qualify ? database.name : 'table',
        });
      }
      for (const view of database.views) {
        suggestions.push({
          label: qualify ? `${database.name}.${view}` : view,
          kind: 'view',
          detail: qualify ? database.name : 'view',
        });
      }
    }
    this.tableSuggestionsCache = suggestions;
    return suggestions;
  }

  /** Column suggestions for the tables referenced by the edited statement. */
  async columnSuggestionsForRefs(tableRefs: string[]): Promise<SqlSuggestion[]> {
    const seen = new Set<string>();
    const suggestions: SqlSuggestion[] = [];
    for (const ref of tableRefs) {
      const resolved = this.resolveRef(ref);
      if (!resolved) continue;
      const key = `${resolved.schema ?? ''}.${resolved.table}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let columns: { name: string; type: string }[];
      try {
        columns = await this.columnsFor(resolved);
      } catch {
        continue;
      }
      for (const column of columns) suggestions.push({ label: column.name, kind: 'column', detail: column.type });
    }
    return suggestions;
  }

  private columnsFor(resolved: { schema?: string; table: string }) {
    const key = `${resolved.schema ?? ''}.${resolved.table}`;
    let promise = this.columnPromises.get(key);
    if (!promise) {
      promise = this.options.fetchColumns(resolved);
      this.columnPromises.set(key, promise);
      promise.catch(() => this.columnPromises.delete(key));
    }
    return promise;
  }

  /**
   * `db.table` splits directly; a bare name resolves against the schema tree.
   * MySQL has no default-schema fallback on the bridge (SHOW COLUMNS needs the
   * right database), so bare unknown names resolve to nothing there; pg
   * handlers default the schema to "public".
   */
  private resolveRef(ref: string): { schema?: string; table: string } | null {
    const raw = ref.replace(/[`"']/g, '');
    const dotIndex = raw.indexOf('.');
    if (dotIndex > 0) return { schema: raw.slice(0, dotIndex), table: raw.slice(dotIndex + 1) };
    const database = this.options.databases.find(
      (db) => db.tables.includes(raw) || db.views.includes(raw),
    );
    if (database) return { schema: database.name, table: raw };
    return this.options.dialect === 'postgresql' ? { table: raw } : null;
  }
}

// ---------------------------------------------------------------------------
// Parser loading
// ---------------------------------------------------------------------------

const parserPromises = new Map<SqlDialect, Promise<SqlParserLike>>();

/** Lazy per-dialect parser singleton; dynamic import keeps ANTLR out of the main bundle. */
export function loadSqlParser(dialect: SqlDialect): Promise<SqlParserLike> {
  let promise = parserPromises.get(dialect);
  if (!promise) {
    promise = import('dt-sql-parser').then((module) => {
      const Impl = dialect === 'mysql' ? module.MySQL : module.PostgreSQL;
      return new Impl() as SqlParserLike;
    });
    promise.catch(() => parserPromises.delete(dialect));
    parserPromises.set(dialect, promise);
  }
  return promise;
}

// ---------------------------------------------------------------------------
// Monaco glue
// ---------------------------------------------------------------------------

export interface SqlEditorContext {
  dialect: SqlDialect;
  /** Null until the schemaTree loads (or on failure) — completions then serve keywords only. */
  catalog?: SqlSchemaCatalog | null;
}

/** Model → query-editor context; models without one (e.g. plain .sql files) get keywords only. */
const contextByModel = new WeakMap<object, SqlEditorContext>();

export function setSqlEditorContext(model: object, context: SqlEditorContext | null): void {
  if (context) contextByModel.set(model, context);
  else contextByModel.delete(model);
}

type RegisteredDisposable = { dispose: () => void };

const SQL_LANGUAGE_IDS: { id: string; dialect: SqlDialect }[] = [
  { id: 'sql', dialect: 'mysql' },
  { id: 'pgsql', dialect: 'postgresql' },
];

const registeredMonacoInstances = new WeakSet<Monaco>();

/** Registers keyword/schema completion providers for 'sql' and 'pgsql', once per Monaco instance. */
export function registerSqlCompletionProviders(monaco: Monaco): RegisteredDisposable {
  if (registeredMonacoInstances.has(monaco)) {
    return { dispose() {} };
  }
  registeredMonacoInstances.add(monaco);
  const disposables = SQL_LANGUAGE_IDS.map(({ id }) =>
    monaco.languages.registerCompletionItemProvider(id, {
      triggerCharacters: ['.', '`'],
      provideCompletionItems: async (model, position) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const context = contextByModel.get(model) ?? null;
        const dialect = context?.dialect ?? (id === 'pgsql' ? 'postgresql' : 'mysql');
        let parser: SqlParserLike;
        try {
          parser = await loadSqlParser(dialect);
        } catch {
          return { suggestions: [] };
        }
        const suggestions = await computeSqlSuggestions({
          parser,
          text: model.getValue(),
          position,
          catalog: context?.catalog ?? null,
          dialect,
        });
        return {
          suggestions: suggestions.map((suggestion) => ({
            label: suggestion.label,
            // Schema names outrank parser keywords in the list.
            sortText: `${suggestion.kind === 'keyword' ? '2' : '1'}${suggestion.label.toLowerCase()}`,
            kind: suggestion.kind === 'keyword'
              ? monaco.languages.CompletionItemKind.Keyword
              : suggestion.kind === 'column'
                ? monaco.languages.CompletionItemKind.Field
                : monaco.languages.CompletionItemKind.Class,
            detail: suggestion.detail,
            insertText: suggestion.label,
            range,
          })),
        };
      },
    }),
  );
  return {
    dispose() {
      for (const disposable of disposables) disposable.dispose();
      registeredMonacoInstances.delete(monaco);
    },
  };
}

export interface SqlValidationEditorLike {
  getModel(): { getValue(): string } | null;
  onDidChangeModelContent(listener: () => void): RegisteredDisposable;
}

const SQL_MARKER_OWNER = 'quolldesk-sql';

type MarkerModel = Parameters<Monaco['editor']['setModelMarkers']>[0];

/**
 * Debounced syntax validation (red squiggles) for one editor. Markers land on
 * the editor's current model under the 'quolldesk-sql' owner and are cleared on
 * dispose; empty statements and unavailable parsers are skipped.
 */
export function attachSqlValidation(
  editor: SqlValidationEditorLike,
  monaco: Monaco,
  getContext: () => SqlEditorContext | null,
  options?: { debounceMs?: number },
): RegisteredDisposable {
  const debounceMs = options?.debounceMs ?? 500;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let runGeneration = 0;

  const run = async () => {
    const generation = ++runGeneration;
    const context = getContext();
    const model = editor.getModel();
    if (!context || !model) return;
    const text = model.getValue();
    const clearMarkers = () => monaco.editor.setModelMarkers(model as MarkerModel, SQL_MARKER_OWNER, []);
    if (!text.trim()) {
      clearMarkers();
      return;
    }
    let parser: SqlParserLike;
    try {
      parser = await loadSqlParser(context.dialect);
    } catch {
      return;
    }
    if (disposed || generation !== runGeneration) return;
    monaco.editor.setModelMarkers(model as MarkerModel, SQL_MARKER_OWNER, toMonacoMarkers(parser.validate(text)));
  };

  const listener = editor.onDidChangeModelContent(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, debounceMs);
  });

  return {
    dispose() {
      disposed = true;
      listener.dispose();
      if (timer) clearTimeout(timer);
      try {
        const model = editor.getModel();
        if (model) monaco.editor.setModelMarkers(model as MarkerModel, SQL_MARKER_OWNER, []);
      } catch {
        // Model may already be disposed during teardown.
      }
    },
  };
}
