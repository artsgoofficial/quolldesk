import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Monaco } from '@monaco-editor/react';
import {
  SqlSchemaCatalog,
  attachSqlValidation,
  computeSqlSuggestions,
  registerSqlCompletionProviders,
  setSqlEditorContext,
  toMonacoMarkers,
} from './sqlIntellisense.ts';

// dt-sql-parser ships an ESM barrel with directory imports that breaks static
// named imports under node's strict loader; dynamic import resolves correctly
// (same path the production module uses).
const { MySQL, PostgreSQL } = await import('dt-sql-parser');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Caret one past the end of a single-line string (matches the parser's 1-based columns). */
const endCaret = (text: string) => ({ lineNumber: 1, column: text.length + 1 });

test('suggests qualified schema tables plus keywords in table context', async () => {
  const catalog = new SqlSchemaCatalog({
    dialect: 'mysql',
    databases: [
      { name: 'app', tables: ['users', 'orders'], views: ['user_summary'] },
      { name: 'other', tables: ['logs'], views: [] },
    ],
    fetchColumns: async () => [],
  });
  const items = await computeSqlSuggestions({
    parser: new MySQL(),
    text: 'SELECT * FROM ',
    position: endCaret('SELECT * FROM '),
    catalog,
    dialect: 'mysql',
  });
  const entities = items.filter((item) => item.kind !== 'keyword').map((item) => item.label);
  assert.deepEqual(entities.sort(), ['app.orders', 'app.users', 'app.user_summary', 'other.logs'].sort());
  assert.ok(items.some((item) => item.kind === 'keyword' && item.label.length > 0));
  const tableItem = items.find((item) => item.label === 'app.users');
  assert.equal(tableItem?.kind, 'table');
  const viewItem = items.find((item) => item.label === 'app.user_summary');
  assert.equal(viewItem?.kind, 'view');
});

test('uses unqualified table names when a single database is present', async () => {
  const catalog = new SqlSchemaCatalog({
    dialect: 'mysql',
    databases: [{ name: 'shop', tables: ['users'], views: ['monthly_sales'] }],
    fetchColumns: async () => [],
  });
  const items = await computeSqlSuggestions({
    parser: new MySQL(),
    text: 'SELECT * FROM ',
    position: endCaret('SELECT * FROM '),
    catalog,
    dialect: 'mysql',
  });
  const entities = items.filter((item) => item.kind !== 'keyword').map((item) => item.label);
  assert.deepEqual(entities.sort(), ['monthly_sales', 'users']);
});

test('suggests columns of referenced tables in column context', async () => {
  const fetchColumnsCalls: { schema?: string; table: string }[] = [];
  const catalog = new SqlSchemaCatalog({
    dialect: 'mysql',
    databases: [{ name: 'app', tables: ['users'], views: [] }],
    fetchColumns: async (args) => {
      fetchColumnsCalls.push(args);
      return [
        { name: 'id', type: 'int' },
        { name: 'name', type: 'varchar(255)' },
      ];
    },
  });
  const text = 'SELECT * FROM app.users WHERE ';
  const items = await computeSqlSuggestions({
    parser: new MySQL(),
    text,
    position: endCaret(text),
    catalog,
    dialect: 'mysql',
  });
  const columns = items.filter((item) => item.kind === 'column');
  assert.deepEqual(columns.map((c) => c.label).sort(), ['id', 'name']);
  assert.equal(columns.find((c) => c.label === 'id')?.detail, 'int');
  assert.deepEqual(fetchColumnsCalls, [{ schema: 'app', table: 'users' }]);
});

test('falls back to keywords when no catalog is registered', async () => {
  const text = 'SELECT id ';
  const items = await computeSqlSuggestions({
    parser: new MySQL(),
    text,
    position: endCaret(text),
    catalog: null,
    dialect: 'mysql',
  });
  assert.ok(items.length > 0);
  assert.ok(items.every((item) => item.kind === 'keyword'));
});

test('suggests schema tables for the postgresql dialect', async () => {
  const catalog = new SqlSchemaCatalog({
    dialect: 'postgresql',
    databases: [{ name: 'public', tables: ['users'], views: [] }],
    fetchColumns: async () => [],
  });
  const items = await computeSqlSuggestions({
    parser: new PostgreSQL(),
    text: 'SELECT * FROM ',
    position: endCaret('SELECT * FROM '),
    catalog,
    dialect: 'postgresql',
  });
  assert.deepEqual(
    items.filter((item) => item.kind === 'table').map((item) => item.label),
    ['users'],
  );
});

test('maps parser validation errors to monaco error markers', () => {
  const markers = toMonacoMarkers([
    { startLine: 2, startColumn: 1, endLine: 2, endColumn: 6, message: 'boom' },
  ]);
  assert.deepEqual(markers, [
    { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 6, message: 'boom', severity: 8 },
  ]);
  assert.deepEqual(toMonacoMarkers([]), []);
});

test('registers completion providers once per monaco instance for sql and pgsql', () => {
  const registered: string[] = [];
  const createMonaco = () =>
    ({
      languages: {
        CompletionItemKind: { Class: 'class', Field: 'field', Keyword: 'keyword' },
        registerCompletionItemProvider: (id: string) => {
          registered.push(id);
          return { dispose() {} };
        },
      },
    }) as unknown as Monaco;
  const first = createMonaco();
  const disposable = registerSqlCompletionProviders(first);
  registerSqlCompletionProviders(first);
  registerSqlCompletionProviders(createMonaco());
  assert.deepEqual(registered, ['sql', 'pgsql', 'sql', 'pgsql']);
  assert.equal(typeof disposable.dispose, 'function');
});

test('completion provider serves keywords, and schema tables when a model context is set', async () => {
  const kind = { Class: 'class', Field: 'field', Keyword: 'keyword' };
  let provider: { provideCompletionItems: (model: unknown, position: unknown) => Promise<{ suggestions: unknown[] }> } | null = null;
  const monaco = {
    languages: {
      CompletionItemKind: kind,
      registerCompletionItemProvider: (_id: string, p: typeof provider) => {
        provider = p;
        return { dispose() {} };
      },
    },
  } as unknown as Monaco;
  registerSqlCompletionProviders(monaco);
  const model = {
    getLanguageId: () => 'sql',
    getWordUntilPosition: () => ({ startColumn: 15, endColumn: 15, word: '' }),
    getValue: () => 'SELECT * FROM ',
    uri: { scheme: 'inmemory' },
  };
  const position = { lineNumber: 1, column: 15 };

  const plain = await provider!.provideCompletionItems(model, position);
  assert.ok((plain.suggestions as { label: unknown }[]).length > 0);
  assert.ok(
    (plain.suggestions as { label: unknown }[]).every((item) => item.label !== 'users'),
    'no schema items without a model context',
  );

  const catalog = new SqlSchemaCatalog({
    dialect: 'mysql',
    databases: [{ name: 'shop', tables: ['users'], views: [] }],
    fetchColumns: async () => [],
  });
  setSqlEditorContext(model, { dialect: 'mysql', catalog });
  const withSchema = await provider!.provideCompletionItems(model, position);
  const tableSuggestion = (withSchema.suggestions as { label: string; kind: string; range: unknown }[]).find(
    (item) => item.label === 'users',
  );
  assert.equal(tableSuggestion?.kind, kind.Class);
  assert.deepEqual(tableSuggestion?.range, {
    startLineNumber: 1,
    endLineNumber: 1,
    startColumn: 15,
    endColumn: 15,
  });
});

test('validation attaches debounced error markers and clears them on dispose', async () => {
  const markerCalls: { owner: string; markers: unknown[] }[] = [];
  let text = 'SELETC 1';
  const model = { getValue: () => text, uri: {} };
  const listeners: (() => void)[] = [];
  const editor = {
    getModel: () => model,
    onDidChangeModelContent: (cb: () => void) => {
      listeners.push(cb);
      return { dispose() {} };
    },
  };
  const monaco = {
    editor: {
      setModelMarkers: (_model: unknown, owner: string, markers: unknown[]) => {
        markerCalls.push({ owner, markers });
      },
    },
  } as unknown as Monaco;

  const disposer = attachSqlValidation(editor, monaco, () => ({ dialect: 'mysql' }), { debounceMs: 1 });
  listeners[0]();
  await sleep(30);
  const invalid = markerCalls.at(-1)!;
  assert.equal(invalid.owner, 'quolldesk-sql');
  assert.equal(invalid.markers.length, 1);

  text = 'SELECT 1';
  listeners[0]();
  await sleep(30);
  assert.deepEqual(markerCalls.at(-1)!.markers, []);

  disposer.dispose();
  assert.deepEqual(markerCalls.at(-1)!.markers, []);
});
