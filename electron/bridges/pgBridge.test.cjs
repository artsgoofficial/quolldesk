"use strict";
const { waitForPush } = require("./dbCommon/testHelpers.cjs");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const registry = require("./dbCommon/connectionRegistry.cjs");

function makeFakePg() {
  const clients = [];
  const queries = [];
  const counters = { streamQueries: 0 };
  class FakeClient {
    constructor(opts) {
      this.opts = opts; clients.push(this);
      this.listeners = {};
    }
    // Minimal EventEmitter surface for the driver-death watch (error/end).
    on(event, fn) { (this.listeners[event] ||= []).push(fn); return this; }
    emit(event, arg) { for (const fn of this.listeners[event] || []) fn(arg); return this; }
    async connect() {}
    async end() {}
    async query(textOrObj) {
      queries.push(textOrObj);
      const text = typeof textOrObj === "string" ? textOrObj : textOrObj.text;
      const lower = String(text).toLowerCase();
      // Simple-query multi-statement scripts resolve as an ARRAY of
      // per-statement results (pg simple protocol); only user SQL with ";"
      // reaches this route — internal queries never contain ";".
      if (String(text).includes(";")) {
        return [
          { rows: [{ id: 1, name: "a" }, { id: 2, name: "b" }], fields: [{ name: "id" }, { name: "name" }] },
          { rows: [{ marker: "last" }], fields: [{ name: "marker" }], rowCount: 1 },
        ];
      }
      // Route checks ordered most-specific first: the pg_class queries also
      // mention pg_namespace, so relkind/reltuples must win over nspname. The
      // tableMeta estimate query selects reltuples AND relkind, so it must be
      // routed on reltuples before the schemaTree relkind route; the estimated
      // relation arrives as the $2 value — v_orders is a view, users a table.
      if (lower.includes("reltuples")) {
        const table = Array.isArray(textOrObj?.values) ? String(textOrObj.values[1] ?? "") : "";
        return table === "v_orders"
          ? { rows: [{ estimate: "42", kind: "v" }] }
          : { rows: [{ estimate: "42", kind: "r" }] };
      }
      // Single-round-trip schema listing (schemaTree + backup): must route
      // before the plain relkind check — the JOIN ON clause mentions relkind.
      if (lower.includes("left join pg_class")) {
        return { rows: [
          { schema_name: "public", table_name: "users", kind: "r" },
          { schema_name: "public", table_name: "v_orders", kind: "v" },
          { schema_name: "empty_schema", table_name: null, kind: null },
        ] };
      }
      if (lower.includes("relkind")) {
        return { rows: [{ table_name: "users", kind: "r" }, { table_name: "v_orders", kind: "v" }] };
      }
      // Backup PK inference + tableMeta PK flag must route before the FK
      // table_constraints route (the PK query mentions both).
      if (lower.includes("primary key")) {
        return { rows: [{ column_name: "id", constraint_name: "users_pkey" }] };
      }
      // tableMeta index columns + access method (pg_index/indkey, pg_am).
      // Distinct from the backup pg_indexes route below — the backup dump
      // still needs full indexdefs.
      if (lower.includes("indkey")) {
        return { rows: [{ indexname: "users_pkey", method: "btree", indisunique: true, columns: "id" }] };
      }
      if (lower.includes("pg_get_viewdef")) {
        return { rows: [{ def: "SELECT id, name FROM users" }] };
      }
      if (lower.includes("information_schema.triggers")) {
        return { rows: [{ name: "trg_touch", timing: "BEFORE", event: "UPDATE", statement: "UPDATE users SET touched = now()" }] };
      }
      if (lower.includes("pg_stat_activity")) {
        return { rows: [{ pid: 77, user: "app", app: "worker", state: "active", seconds: "12", query: "SELECT pg_sleep(60)" }] };
      }
      if (lower.includes("pg_terminate_backend") || lower.includes("pg_cancel_backend")) {
        return { rows: [{ ok: true }] };
      }
      if (lower.includes("pg_constraint")) {
        // Composite-capable structural FK rows (pg driver parses int2[]/text[]
        // into JS arrays); actions are the canonical upper-case values.
        return { rows: [
          { name: "fk_users_parent", columns: ["parent_id"], ref_table: "user_groups", ref_schema: "public", ref_columns: ["id"], on_delete: "NO ACTION", on_update: "CASCADE" },
          { name: "fk_users_org", columns: ["org_id"], ref_table: "orgs", ref_schema: "other_schema", ref_columns: ["oid"], on_delete: "SET NULL", on_update: null },
        ] };
      }
      if (lower.includes("nspname")) {
        return { rows: [{ schema_name: "public" }] };
      }
      if (lower.includes("information_schema.columns")) {
        // comment mirrors what col_description(…) returns for the ER panel.
        return { rows: [
          { column_name: "id", data_type: "integer", is_nullable: "NO", default_value: null, comment: "主键ID" },
          { column_name: "name", data_type: "text", is_nullable: "YES", default_value: null, comment: null },
        ] };
      }
      if (lower.includes("pg_indexes")) {
        return { rows: [{ indexname: "users_pkey", indexdef: "CREATE UNIQUE INDEX users_pkey ON public.users (id)" }] };
      }
      if (lower.startsWith("select")) {
        return { rows: [{ id: 1, name: "a" }, { id: 2, name: "b" }], fields: [{ name: "id" }, { name: "name" }] };
      }
      return { rows: [] };
    }
  }
  // runLimitedQuery instantiates QueryStream for every capped query; the
  // query handler uses that path for single-statement SQL, so the counter
  // distinguishes the capped route from the plain multi-statement route.
  const streams = [];
  class FakeQueryStream {
    constructor(text, values) {
      this.text = text;
      this.values = values;
      streams.push(this);
      counters.streamQueries += 1;
    }
  }
  return {
    Client: FakeClient,
    clients,
    queries,
    streams,
    QueryStream: FakeQueryStream,
    get streamQueries() { return counters.streamQueries; },
  };
}

function setup() {
  registry._resetForTests();
  const bridge = require("./pgBridge.cjs");
  const fake = makeFakePg();
  bridge._setDriverForTests(fake);
  const handlers = new Map();
  bridge.registerHandlers({ handle: (c, fn) => handlers.set(c, fn) }, {});
  const pushes = [];
  const event = { sender: { id: 31, isDestroyed: () => false, send: (_channel, payload) => pushes.push(payload), once() {}, removeListener() {} } };
  return { bridge, fake, pushes, call: async (channel, payload) => handlers.get(channel)(event, payload) };
}

/** Poll the captured job-progress pushes until one with `phase` lands. */

function tmpSqlFile(label) {
  return path.join(os.tmpdir(), `nc-pg-bridge-test-${label}-${process.pid}-${Math.random().toString(16).slice(2)}.sql`);
}

test("pg connect/schemaTree/tableMeta/tableRows/query", async () => {
  const { bridge, fake, call } = setup();
  const conn = await call("quolldesk:pg:connect", { hostname: "pg", port: 5432, username: "postgres", password: "pw", config: { database: "app" } });
  assert.equal(conn.ok, true, JSON.stringify(conn));
  const { connectionId } = conn.data;
  assert.equal(fake.clients.length, 1);
  assert.equal(fake.clients[0].opts.database, "app");

  const tree = await call("quolldesk:pg:schemaTree", { connectionId });
  assert.equal(tree.ok, true);
  // Single grouped listing: tables/views bucketed per schema, empty schemas stay.
  assert.deepEqual(tree.data.databases, [
    { name: "public", tables: ["users"], views: ["v_orders"] },
    { name: "empty_schema", tables: [], views: [] },
  ]);

  const meta = await call("quolldesk:pg:tableMeta", { connectionId, table: "users", schema: "public" });
  assert.equal(meta.ok, true);
  assert.equal(meta.data.columns[0].name, "id");
  assert.equal(meta.data.columns[0].key, "PRI", "PK columns carry the mysql-compatible PRI flag");
  // Column comments (ER panel): col_description flows through as `comment`,
  // empty → null so the renderer can skip it.
  assert.equal(meta.data.columns[0].comment, "主键ID", "column comment must surface in tableMeta");
  assert.equal(meta.data.columns[1].comment, null);
  const columnsQuery = fake.queries
    .filter((q) => typeof q === "object" && !Array.isArray(q) && String(q.text ?? "").includes("col_description"))
    .pop();
  assert.ok(columnsQuery, "tableMeta must extract col_description for column comments");
  assert.equal(meta.data.indexes[0].name, "users_pkey");
  assert.deepEqual(meta.data.indexes[0].columns, ["id"]);
  assert.equal(meta.data.indexes[0].unique, true);
  assert.equal(meta.data.indexes[0].method, "btree");
  assert.deepEqual(meta.data.primaryKey, { name: "users_pkey", columns: ["id"] });
  assert.equal(meta.data.rowCountEstimate, 42);
  assert.equal(meta.data.ddl, null, "plain tables keep ddl null");
  // Foreign keys: fourth sequential meta query is bound with [schema, table]
  // and its rows map to { column, refTable, refSchema, refColumn }.
  const fkQuery = fake.queries
    .filter((q) => typeof q === "object" && !Array.isArray(q) && String(q.text ?? "").includes("information_schema.table_constraints"))
    .pop();
  assert.ok(fkQuery, "tableMeta must run the FK pg_constraint query");
  assert.deepEqual(fkQuery.values, ["public", "users"]);
  assert.deepEqual(meta.data.foreignKeys, [
    { name: "fk_users_parent", columns: ["parent_id"], refTable: "user_groups", refSchema: "public", refColumns: ["id"], onDelete: "NO ACTION", onUpdate: "CASCADE" },
    { name: "fk_users_org", columns: ["org_id"], refTable: "orgs", refSchema: "other_schema", refColumns: ["oid"], onDelete: "SET NULL", onUpdate: null },
  ]);
  assert.deepEqual(meta.data.triggers, [
    { name: "trg_touch", timing: "BEFORE", event: "UPDATE", statement: "UPDATE users SET touched = now()" },
  ]);

  // Session manager: list excludes our own backend; kill passes pid through.
  const sessions = await call("quolldesk:pg:sessions", { connectionId });
  assert.equal(sessions.ok, true, JSON.stringify(sessions));
  assert.deepEqual(sessions.data.sessions, [
    { id: "77", user: "app", app: "worker", state: "active", seconds: 12, query: "SELECT pg_sleep(60)" },
  ]);
  const killed = await call("quolldesk:pg:killSession", { connectionId, pid: 77 });
  assert.equal(killed.ok, true, JSON.stringify(killed));

  // A view entry (relkind 'v') must surface its source: the bridge routes the
  // definition through pg_get_viewdef and returns it as ddl.
  const viewMeta = await call("quolldesk:pg:tableMeta", { connectionId, table: "v_orders", schema: "public" });
  assert.equal(viewMeta.ok, true, JSON.stringify(viewMeta));
  assert.equal(viewMeta.data.ddl, "SELECT id, name FROM users");

  const rows = await call("quolldesk:pg:tableRows", { connectionId, table: "users", schema: "public", offset: 0, limit: 100 });
  assert.equal(rows.ok, true);
  // Renderer contract: columns are { name } objects (SqlTableRows type).
  assert.deepEqual(rows.data.columns, [{ name: "id" }, { name: "name" }]);
  assert.equal(rows.data.rows.length, 2);

  // Single-statement SQL routes through runLimitedQuery (streamed, destroyed
  // past MAX_ROWS) so an unbounded SELECT cannot buffer the whole table in the
  // main process. The fake returns plain result objects (no .on), so
  // runLimitedQuery takes its plain-result branch and the envelope content is
  // identical to the old uncapped path — assert the capped route was taken via
  // the QueryStream instantiation counter.
  const streamsBefore = fake.streamQueries;
  const q = await call("quolldesk:pg:query", { connectionId, sql: "SELECT * FROM users" });
  assert.equal(q.ok, true);
  assert.equal(q.data.resultSets[0].rows.length, 2);
  assert.equal(q.data.truncated, false);
  assert.ok(fake.streamQueries > streamsBefore, "single-statement query must use the capped runLimitedQuery path");

  // Multi-statement scripts resolve as an array of results; handler must
  // report the LAST statement's outcome, not an empty result set. They keep
  // the plain-query path, so the capped-path counter must not advance.
  const streamsBeforeMulti = fake.streamQueries;
  const multi = await call("quolldesk:pg:query", { connectionId, sql: "SELECT * FROM users; SELECT 42 AS marker" });
  assert.equal(multi.ok, true, JSON.stringify(multi));
  assert.deepEqual(multi.data.resultSets[0].columns, [{ name: "marker" }]);
  assert.deepEqual(multi.data.resultSets[0].rows, [["last"]]);
  assert.equal(fake.streamQueries, streamsBeforeMulti, "multi-statement script must keep the plain-query path");

  const notConn = await call("quolldesk:pg:query", { connectionId: "nope", sql: "SELECT 1" });
  assert.equal(notConn.error.code, "NOT_CONNECTED");

  await call("quolldesk:pg:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("pg applyTableChanges runs a transaction and returns counts", async () => {
  const registry = require("./dbCommon/connectionRegistry.cjs");
  registry._resetForTests();
  const bridge = require("./pgBridge.cjs");
  const fake = makeFakePg();
  bridge._setDriverForTests(fake);
  const handlers = new Map();
  bridge.registerHandlers({ handle: (c, fn) => handlers.set(c, fn) }, {});
  const event = { sender: { id: 91, isDestroyed: () => false, send() {}, once() {}, removeListener() {} } };
  const call = async (channel, payload) => handlers.get(channel)(event, payload);
  const conn = await call("quolldesk:pg:connect", { hostname: "pg", port: 5432, username: "postgres", password: "pw", config: { database: "app" } });
  const { connectionId } = conn.data;
  const res = await call("quolldesk:pg:applyTableChanges", {
    connectionId,
    table: "users",
    schema: "public",
    changes: {
      updates: [{ pk: "id", pkValue: "1", column: "name", value: "renamed" }],
      deletes: [{ pk: "id", pkValue: "2" }],
    },
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.data.applied, { updates: 1, inserts: 0, deletes: 1 });
  await call("quolldesk:pg:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("pg tableRows orderDir + filters compile to quoted WHERE with $n values", async () => {
  const { bridge, fake, call } = setup();
  const conn = await call("quolldesk:pg:connect", { hostname: "pg", port: 5432, username: "postgres", password: "pw", config: { database: "app" } });
  const { connectionId } = conn.data;
  const res = await call("quolldesk:pg:tableRows", {
    connectionId,
    table: "users",
    schema: "public",
    orderBy: "id",
    orderDir: "asc",
    filters: [
      { column: "name", op: "eq", value: "a" },
      { column: "id", op: "nnul" },
      { column: "evil", op: "DROP TABLE users", value: "x" }, // invalid op must be ignored
    ],
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const last = fake.streams[fake.streams.length - 1];
  assert.ok(last.text.includes('WHERE "name" = $1 AND "id" IS NOT NULL'), last.text);
  assert.ok(last.text.includes('ORDER BY "id" ASC'), last.text);
  assert.ok(!last.text.toUpperCase().includes("DROP"));
  assert.deepEqual(last.values, ["a"]);

  // LIKE wraps the value; placeholders stay positional.
  await call("quolldesk:pg:tableRows", {
    connectionId,
    table: "users",
    schema: "public",
    filters: [{ column: "name", op: "like", value: "ab" }],
  });
  const like = fake.streams[fake.streams.length - 1];
  assert.ok(like.text.includes('WHERE "name" LIKE $1'), like.text);
  assert.deepEqual(like.values, ["%ab%"]);

  // No filters: values stay undefined (no extended-protocol params).
  await call("quolldesk:pg:tableRows", { connectionId, table: "users", schema: "public", orderBy: "id", orderDir: "desc" });
  const plain = fake.streams[fake.streams.length - 1];
  assert.ok(!plain.text.includes("WHERE"));
  assert.ok(plain.text.includes('ORDER BY "id" DESC'));
  assert.equal(plain.values, undefined);

  await call("quolldesk:pg:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("pg backup streams a table dump with CREATE/INSERT/index/view sections", async () => {
  const { bridge, fake, pushes, call } = setup();
  const conn = await call("quolldesk:pg:connect", { hostname: "pg", port: 5432, username: "postgres", password: "pw", config: { database: "app" } });
  const { connectionId } = conn.data;
  const outFile = tmpSqlFile("backup");
  try {
    const res = await call("quolldesk:pg:backup", { connectionId, scope: "table", schema: "public", table: "users", includeData: true, outFile });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(res.data.jobId.length > 0);
    const done = await waitForPush(pushes, "done");
    assert.equal(done.dialect, "postgresql");
    assert.match(done.message, /dumped 1 table/);
    assert.equal(pushes.find((p) => p.phase === "rows").rowsDone, 2);
    assert.equal(pushes.find((p) => p.phase === "tables").table, "public.users");

    const dump = fs.readFileSync(outFile, "utf8");
    assert.ok(dump.includes("-- Dialect: postgresql"), dump.slice(0, 400));
    assert.ok(dump.includes('DROP TABLE IF EXISTS "public"."users" CASCADE;'), dump);
    assert.ok(dump.includes('CREATE TABLE "public"."users" (\n  "id" integer NOT NULL,\n  "name" text\n);'), dump);
    assert.ok(dump.includes('ALTER TABLE "public"."users" ADD PRIMARY KEY ("id");'), dump);
    assert.ok(dump.includes('INSERT INTO "public"."users" ("id", "name") VALUES'), dump);
    // Backup fetches RAW driver rows (no grid cellify): numbers stay bare,
    // strings are quoted — PG re-casts them implicitly on restore.
    assert.ok(dump.includes("(1, 'a'),\n  (2, 'b');"), dump);
    // PK's backing index is emitted AFTER data, idempotent (the PK already
    // created users_pkey via ADD PRIMARY KEY).
    assert.ok(dump.indexOf("INSERT INTO") < dump.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS users_pkey ON public.users (id);"));
    // Table-scope dump must not include the view.
    assert.ok(!dump.includes("v_orders"));

    const pkQuery = fake.queries
      .filter((q) => typeof q === "object" && !Array.isArray(q) && String(q.text ?? "").includes("PRIMARY KEY"))
      .pop();
    assert.deepEqual(pkQuery.values, ["public", "users"]);
    // Data pages run as plain queries (raw rows — never the grid's capped,
    // cell-truncating runLimitedQuery/stream path). Keyset pagination: the
    // first page has no cursor yet — plain ORDER BY + LIMIT, never OFFSET
    // (OFFSET re-scans prior rows on every page).
    const dataQuery = fake.queries
      .filter((q) => typeof q === "object" && !Array.isArray(q) && String(q.text ?? "").includes('FROM "public"."users"'))
      .pop();
    assert.ok(dataQuery, "backup data page must run as a plain query");
    assert.ok(dataQuery.text.includes('SELECT "id", "name" FROM "public"."users" ORDER BY "id" LIMIT 500'), dataQuery.text);
    assert.ok(!dataQuery.text.toUpperCase().includes("OFFSET"), dataQuery.text);
  } finally {
    fs.unlink(outFile, () => {});
  }

  // Database scope on the same fake: tables + view sections in order.
  const allFile = tmpSqlFile("dump-all");
  try {
    const before = pushes.length;
    const res = await call("quolldesk:pg:backup", { connectionId, scope: "database", includeData: true, outFile: allFile });
    assert.equal(res.ok, true, JSON.stringify(res));
    await waitForPush(pushes, "done", 3000, before);
    const dump = fs.readFileSync(allFile, "utf8");
    assert.ok(dump.indexOf('CREATE TABLE "public"."users"') < dump.indexOf('DROP VIEW IF EXISTS "public"."v_orders" CASCADE;'), dump);
    assert.ok(dump.includes('CREATE VIEW "public"."v_orders" AS SELECT id, name FROM users;'), dump);
  } finally {
    fs.unlink(allFile, () => {});
  }

  // Error path: unknown table → error push, partial file removed.
  const beforeErr = pushes.length;
  const badFile = tmpSqlFile("missing");
  const errRes = await call("quolldesk:pg:backup", { connectionId, scope: "table", schema: "public", table: "does_not_exist", outFile: badFile });
  assert.equal(errRes.ok, true);
  const error = await waitForPush(pushes, "error", 3000, beforeErr);
  assert.match(error.error, /table not found/);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fs.existsSync(badFile), false, "partial dump file must be deleted on error");

  await call("quolldesk:pg:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("pg backup dumps jsonb/long-text/bytea values intact (no grid cell truncation)", async () => {
  // Regression: backup data pages once went through runLimitedQuery's grid
  // shaping (serializeCellValue), which truncates every cell at 4KB. A jsonb
  // document longer than 4096 chars was chopped mid-string into the dump —
  // restore then failed with "invalid input syntax for type json"; long text
  // columns were silently truncated. Backup must use RAW driver rows and cast
  // json/jsonb columns to text server-side (scalar documents keep their
  // quotes; PG re-casts the literal on restore).
  registry._resetForTests();
  const bridge = require("./pgBridge.cjs");
  // Row values simulate what pg returns for `SELECT id, "doc"::text, ...`:
  // jsonb arrives as the exact JSON text (scalar strings still quoted).
  const bigJsonText = JSON.stringify({ en: "<p>ArtsGo</p>" + "x".repeat(4900) });
  const rows = [
    { id: 1, doc: bigJsonText, body: "y".repeat(5000), bin: Buffer.from([0xde, 0xad, 0xbe, 0xef]) },
    { id: 2, doc: '"hello"', body: null, bin: null },
  ];
  const clients = [];
  const queries = [];
  // Like makeFakePg: instances keep .text so the fake can route; returning a
  // plain object (not the stream) drives runLimitedQuery's plain-result branch.
  const streams = [];
  class FakeQueryStream {
    constructor(text, values) { this.text = text; this.values = values; streams.push(this); }
  }
  class FakeClient {
    async connect() {}
    async end() {}
    on() { return this; }
    emit() {}
    async query(textOrObj) {
      queries.push(textOrObj);
      const text = typeof textOrObj === "string" ? textOrObj : textOrObj.text;
      const lower = String(text).toLowerCase();
      if (lower.includes("left join pg_class")) {
        return { rows: [{ schema_name: "public", table_name: "docs", kind: "r" }] };
      }
      if (lower.includes("primary key")) {
        return { rows: [{ column_name: "id", constraint_name: "docs_pkey" }] };
      }
      if (lower.includes("information_schema.columns")) {
        return { rows: [
          { column_name: "id", data_type: "integer", is_nullable: "NO", default_value: null },
          { column_name: "doc", data_type: "jsonb", is_nullable: "YES", default_value: null },
          { column_name: "body", data_type: "text", is_nullable: "YES", default_value: null },
          { column_name: "bin", data_type: "bytea", is_nullable: "YES", default_value: null },
        ] };
      }
      if (lower.includes("pg_indexes")) return { rows: [] };
      if (lower.includes("information_schema.triggers")) {
        return { rows: [{ name: "trg_touch", timing: "BEFORE", event: "UPDATE", statement: "UPDATE users SET touched = now()" }] };
      }
      if (lower.includes("pg_constraint")) {
        return { rows: [{ name: "fk_docs_parent", def: "FOREIGN KEY (parent_id) REFERENCES parents(id) ON DELETE CASCADE" }] };
      }
      if (lower.includes("pg_trigger")) {
        return { rows: [{ name: "trg_docs", def: "CREATE TRIGGER trg_docs AFTER INSERT ON public.docs FOR EACH ROW EXECUTE FUNCTION trg_fn()" }] };
      }
      if (lower.includes("pg_proc")) {
        return { rows: [{ name: "demo_fn", def: "CREATE OR REPLACE FUNCTION public.demo_fn(p integer) RETURNS integer LANGUAGE plpgsql AS $$BEGIN RETURN p + 1;END;$$" }] };
      }
      if (lower.includes('from "public"."docs"')) {
        return { rows, fields: [{ name: "id" }, { name: "doc" }, { name: "body" }, { name: "bin" }] };
      }
      return { rows: [] };
    }
  }
  const fake = { Client: FakeClient, clients, queries, QueryStream: FakeQueryStream };
  bridge._setDriverForTests(fake);
  const handlers = new Map();
  bridge.registerHandlers({ handle: (c, fn) => handlers.set(c, fn) }, {});
  const pushes = [];
  const event = { sender: { id: 33, isDestroyed: () => false, send: (_c, p) => pushes.push(p), once() {}, removeListener() {} } };
  const call = async (channel, payload) => handlers.get(channel)(event, payload);
  const outFile = tmpSqlFile("backup-jsonb");
  try {
    const conn = await call("quolldesk:pg:connect", { hostname: "pg", port: 5432, username: "postgres", password: "pw", config: { database: "app" } });
    const { connectionId } = conn.data;
    // Database scope so the routines section runs alongside per-table dumps.
    const res = await call("quolldesk:pg:backup", { connectionId, scope: "database", includeData: true, outFile });
    assert.equal(res.ok, true, JSON.stringify(res));
    await waitForPush(pushes, "done");

    const dump = fs.readFileSync(outFile, "utf8");
    // json/jsonb columns must be fetched via a server-side text cast so the
    // driver hands back the exact document.
    const dataQuery = queries
      .map((q) => String(typeof q === "object" && q ? q.text : q))
      .find((t) => t.includes('from "public"."docs"') || t.includes('FROM "public"."docs"'));
    assert.ok(dataQuery, "backup must query the docs table");
    assert.ok(dataQuery.includes(`"doc"::text`), dataQuery);
    assert.ok(dump.includes(`INSERT INTO "public"."docs"`), dump.slice(0, 600));
    // The full jsonb document (5 KB) must survive verbatim.
    assert.ok(dump.includes(bigJsonText), "jsonb document longer than 4KB must not be truncated");
    assert.ok(dump.includes(`'${bigJsonText.replace(/'/g, "''")}'`), "jsonb document must be a single complete SQL literal");
    // jsonb scalar string: the dump literal must remain valid JSON ('"hello"',
    // not bare 'hello' which fails restore with invalid input syntax for json).
    assert.ok(dump.includes(`'"hello"'`), dump.slice(dump.indexOf("VALUES"), dump.indexOf("VALUES") + 400));
    // Long text column: full 5000 chars, not the grid's 4KB cap.
    assert.ok(dump.includes("y".repeat(5000)), "text column longer than 4KB must not be truncated");
    // bytea: hex literal path, never the JSON Buffer serialization.
    assert.ok(dump.includes(`'\\xDEADBEEF'::bytea`), "bytea must dump as a hex literal");
    assert.ok(!dump.includes('"type":"Buffer"'), "bytea must not leak the JSON Buffer shape");
    // FK constraints are dumped after indexes as named ADD CONSTRAINT statements.
    assert.ok(
      dump.includes('ALTER TABLE "public"."docs" ADD CONSTRAINT "fk_docs_parent" FOREIGN KEY (parent_id) REFERENCES parents(id) ON DELETE CASCADE;'),
      "dump must carry the FK constraint",
    );
    // Triggers dump after FKs with their full CREATE TRIGGER definition.
    assert.ok(
      dump.includes('CREATE TRIGGER trg_docs AFTER INSERT ON public.docs FOR EACH ROW EXECUTE FUNCTION trg_fn();'),
      "dump must carry the trigger definition",
    );
    // Routines dump last as CREATE OR REPLACE FUNCTION with $$ bodies intact.
    assert.ok(
      dump.includes('CREATE OR REPLACE FUNCTION public.demo_fn(p integer) RETURNS integer LANGUAGE plpgsql AS $$BEGIN RETURN p + 1;END;$$;'),
      "dump must carry the routine definition",
    );

    await call("quolldesk:pg:disconnect", { connectionId });
  } finally {
    fs.unlink(outFile, () => {});
    bridge._setDriverForTests(undefined);
  }
});

test("pg restore executes statements sequentially and reports progress", async () => {
  const { bridge, fake, pushes, call } = setup();
  const conn = await call("quolldesk:pg:connect", { hostname: "pg", port: 5432, username: "postgres", password: "pw", config: { database: "app" } });
  const { connectionId } = conn.data;
  const before = fake.queries.length;
  const inFile = tmpSqlFile("restore");
  const script = [
    "-- QuollDesk dump header",
    'DROP TABLE IF EXISTS public.t;',
    "INSERT INTO public.t VALUES ('a;b');", // `;` inside the string must not split
  ].join("\n");
  try {
    fs.writeFileSync(inFile, script, "utf8");
    const res = await call("quolldesk:pg:restore", { connectionId, inFile });
    assert.equal(res.ok, true, JSON.stringify(res));
    const done = await waitForPush(pushes, "done");
    assert.match(done.message, /2 statements executed/);
    const executed = fake.queries.slice(before)
      .map((q) => (typeof q === "string" ? q : q.text));
    assert.deepEqual(executed, ["DROP TABLE IF EXISTS public.t", "INSERT INTO public.t VALUES ('a;b')"]);
    assert.equal(pushes.find((p) => p.phase === "restore").total, 2);
  } finally {
    fs.unlink(inFile, () => {});
  }

  // Error path: second statement fails → error push with its index, run stops.
  const beforeErr = pushes.length;
  const executedAfter = fake.queries.length;
  fake.clients[0].query = (textOrObj) => {
    const text = typeof textOrObj === "string" ? textOrObj : textOrObj.text;
    if (String(text).includes("boom")) throw new Error("boom at statement 2");
    fake.queries.push(textOrObj);
    return { rows: [] };
  };
  const badFile = tmpSqlFile("restore-err");
  fs.writeFileSync(badFile, "SELECT 1;\nSELECT boom;\nSELECT 3;\n", "utf8");
  try {
    const res = await call("quolldesk:pg:restore", { connectionId, inFile: badFile });
    assert.equal(res.ok, true);
    const error = await waitForPush(pushes, "error", 3000, beforeErr);
    assert.equal(error.index, 1);
    assert.match(error.error, /boom at statement 2/);
    assert.equal(fake.queries.length - executedAfter, 1, "run must stop at the failed statement");
  } finally {
    fs.unlink(badFile, () => {});
  }

  await call("quolldesk:pg:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("pg driver death evicts the connection; later ops return NOT_CONNECTED", async () => {
  const { bridge, call, fake } = setup();
  const conn = await call("quolldesk:pg:connect", { hostname: "pg", port: 5432, username: "postgres", password: "pw", config: { database: "app" } });
  const { connectionId } = conn.data;
  const client = fake.clients[fake.clients.length - 1];
  // Server crash / network drop: pg emits a fatal 'error'. The bridge must
  // evict the registry entry (double-fire is safe via idempotent close) so
  // the renderer's next op fails closed instead of on a dead client.
  client.emit("error", new Error("server went away"));
  assert.equal(registry.getConnection(connectionId), undefined);
  const res = await call("quolldesk:pg:tableRows", { connectionId, table: "users" });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "NOT_CONNECTED");
  client.emit("error", new Error("again")); // idempotent: no throw
  await call("quolldesk:pg:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("pg connection 'end' (server closed socket) evicts the connection too", async () => {
  const { bridge, call, fake } = setup();
  const conn = await call("quolldesk:pg:connect", { hostname: "pg", port: 5432, username: "postgres", password: "pw", config: { database: "app" } });
  const { connectionId } = conn.data;
  const client = fake.clients[fake.clients.length - 1];
  client.emit("end");
  assert.equal(registry.getConnection(connectionId), undefined);
  await call("quolldesk:pg:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("pg pickBackupPath / pickRestoreFile use the injected dialog", async () => {
  const { bridge, call } = setup();
  const seen = [];
  bridge._setDialogForTests({
    showSaveDialog: async (owner, opts) => { seen.push({ owner, opts }); return { canceled: false, filePath: "/tmp/out.sql" }; },
    showOpenDialog: async () => ({ canceled: false, filePaths: ["/tmp/in.sql"] }),
  });
  const picked = await call("quolldesk:pg:pickBackupPath", { defaultName: "app_database_20260101.sql" });
  assert.deepEqual(picked, { ok: true, data: { path: "/tmp/out.sql" } });
  assert.equal(seen[0].opts.defaultPath, "app_database_20260101.sql");
  const opened = await call("quolldesk:pg:pickRestoreFile");
  assert.deepEqual(opened, { ok: true, data: { path: "/tmp/in.sql" } });

  bridge._setDialogForTests({ showOpenDialog: async () => ({ canceled: true, filePaths: [] }) });
  const cancelled = await call("quolldesk:pg:pickRestoreFile");
  assert.deepEqual(cancelled, { ok: true, data: { path: null } });

  bridge._setDialogForTests(undefined);
  bridge._setDriverForTests(undefined);
});
