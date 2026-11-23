const test = require("node:test");
const { waitForPush } = require("./dbCommon/testHelpers.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const registry = require("./dbCommon/connectionRegistry.cjs");

// Fake driver mirroring the REAL mssql (tedious) public API surface the bridge
// is allowed to touch (verified against node_modules/mssql 12.x source):
// - new ConnectionPool(cfg) → pool.connect() → Promise<pool>
// - pool.request(overrides) → Request (overrides: { requestTimeout })
// - req.input(name, value) → chainable; req.query(sql) →
//   { recordsets: [...], recordset, rowsAffected: [n, ...] }
// - pool.transaction() / new Transaction(pool) → { begin, commit, rollback }
// - new Request(tx) — a Request bound to a transaction (queries route via
//   parent: pool when parent.config exists, otherwise parent.pool).
// Routing: the test installs pool.respond(sql, req); every executed statement
// is recorded in pool.queryLog ({ sql, parameters, overrides, onTx }).
function makeFakeMssql() {
  const state = { pools: [] };
  class FakeRequest {
    constructor(parent, overrides = {}) {
      this.parent = parent;
      this.overrides = overrides || {};
      this.parameters = {};
    }
    input(name, value) { this.parameters[name] = value; return this; }
    async query(sql) {
      const pool = this.parent && this.parent.config ? this.parent : this.parent.pool;
      pool.queryLog.push({
        sql,
        parameters: { ...this.parameters },
        overrides: { ...this.overrides },
        onTx: pool.transactions.includes(this.parent),
      });
      const res = (pool.respond || makeResponder({}))(sql, this, pool);
      if (res && res.__error) throw res.error;
      return {
        recordsets: (res && res.recordsets) || [],
        recordset: res && res.recordsets && res.recordsets[0],
        rowsAffected: (res && res.rowsAffected) || [],
      };
    }
  }
  class FakeTransaction {
    constructor(pool) {
      this.pool = pool;
      this.events = [];
      pool.transactions.push(this);
    }
    async begin() { this.events.push("begin"); }
    async commit() { this.events.push("commit"); }
    async rollback() { this.events.push("rollback"); }
  }
  class FakeConnectionPool {
    constructor(config) {
      this.config = config;
      this.queryLog = [];
      this.transactions = [];
      state.pools.push(this);
      this.closed = false;
    }
    async connect() { return this; }
    request(overrides) { return new FakeRequest(this, overrides); }
    transaction() { return new FakeTransaction(this); }
    async close() { this.closed = true; }
  }
  return { ConnectionPool: FakeConnectionPool, Request: FakeRequest, Transaction: FakeTransaction, state };
}

// SQL-shape router with per-test data. Keys mirror the bridge's query shapes.
function makeResponder(data = {}) {
  const first = (rows) => ({ recordsets: [rows], rowsAffected: [rows.length] });
  return (sql, req) => {
    const lower = String(sql).toLowerCase();
    if (lower.includes("@@version")) return first([{ v: data.version || "Microsoft SQL Server 2022 (RTM-CU12) 16.0.4135.4" }]);
    if (lower.startsWith("select s.name as schema_name")) return first(data.listing || []);
    if (lower.includes("information_schema.columns")) return first(data.columns || []);
    if (lower.includes("table_constraints") && lower.includes("primary key")) return first(data.pk || []);
    if (lower.includes("sys.indexes")) return first(data.indexes || []);
    if (lower.includes("sys.triggers")) return first(data.trgs || []);
    if (lower.includes("dm_exec_sessions")) return first(data.sessionsList || []);
    if (lower.startsWith("kill")) return first([]);
    if (lower.includes("sys.sql_modules")) {
      const def = data.ddl ? data.ddl[req.parameters.qualified || ""] : null;
      return first(def ? [{ definition: def }] : []);
    }
    if (lower.includes("sys.partitions")) return first([{ c: data.rowCount != null ? data.rowCount : 0 }]);
    if (lower.includes("sys.foreign_keys")) return first(data.fks || []);
    if (lower.includes("select * from")) {
      if (typeof data.page === "function") return first(data.page(sql, req) || []);
      return first([]);
    }
    return { recordsets: [], rowsAffected: [1] };
  };
}

/**
 * Mini T-SQL executor for exactly the statement shapes OUR dump emits — used
 * to prove dumps are restorable: the bridge's restore channel executes each
 * statement through a fake connection into this executor, then the restored
 * table is read back and compared to the backup source values. Parses:
 * `IF OBJECT_ID(N'..', 'U'|'V') IS NOT NULL DROP TABLE|VIEW ..` (with ''
 * un-escaping), `CREATE TABLE [s].[t] (...)` (column types), and multi-row
 * `INSERT INTO [s].[t] (..) VALUES (..), (..)` with NULL / number / 'string'
 * / 0xHEX literals (any other literal is rejected — proving the dump never
 * emits dialect-foreign forms like TRUE or '\x..'::bytea).
 */
function makeMiniExecutor() {
  const tables = new Map(); // "[s].[t]" → { columns: [{ name, type }], rows: [raw objects] }
  const unescape = (s) => s.replace(/''/g, "'");
  const splitTop = (text) => {
    const parts = [];
    let depth = 0, current = "", inSingle = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (inSingle) {
        current += ch;
        if (ch === "'") { if (text[i + 1] === "'") { current += "'"; i += 1; } else inSingle = false; }
        continue;
      }
      if (ch === "'") { inSingle = true; current += ch; continue; }
      if (ch === "(" || ch === "[") depth += 1;
      else if (ch === ")" || ch === "]") depth -= 1;
      if (ch === "," && depth === 0) { parts.push(current); current = ""; continue; }
      current += ch;
    }
    parts.push(current);
    return parts.map((p) => p.trim()).filter(Boolean);
  };
  const parseValue = (token) => {
    const t = token.trim();
    if (/^NULL$/i.test(t)) return null;
    if (/^0X[0-9A-F]*$/i.test(t)) return Buffer.from(t.slice(2), "hex");
    if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);
    if (/^'[\s\S]*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
    throw new Error(`unparseable dump literal: ${token}`);
  };
  const stripComments = (text) => String(text).replace(/^(?:\s|--[^\n]*\n)+/, "");
  const exec = (statement) => {
    const text = stripComments(statement);
    const drop = text.match(/^IF OBJECT_ID\(N'((?:[^']|'')*)', '(?:U|V)'\) IS NOT NULL DROP (?:TABLE|VIEW) (.+)$/);
    if (drop) { tables.delete(unescape(drop[1])); return; }
    const create = text.match(/^CREATE TABLE ((?:\[[^\]]+\]\.)?\[[^\]]+\])\s*\(([\s\S]+)\)$/);
    if (create) {
      const columns = splitTop(create[2]).map((def) => {
        const m = def.match(/^\[([^\]]+)\]\s+([A-Za-z]+)/);
        return { name: m[1], type: m[2].toUpperCase() };
      });
      tables.set(create[1], { columns, rows: [] });
      return;
    }
    const insert = text.match(/^INSERT INTO ((?:\[[^\]]+\]\.)?\[[^\]]+\])\s*\(([^)]+)\)\s*VALUES([\s\S]+)$/i);
    if (insert) {
      const entry = tables.get(insert[1]);
      if (!entry) throw new Error(`INSERT into unknown table ${insert[1]}`);
      const names = insert[2].split(",").map((c) => c.trim().slice(1, -1));
      for (const tuple of splitTop(insert[3])) {
        const values = splitTop(tuple.replace(/^\(/, "").replace(/\)$/, ""));
        const row = {};
        names.forEach((name, i) => { row[name] = parseValue(values[i]); });
        entry.rows.push(row);
      }
      return;
    }
    // CREATE VIEW and anything else: no table state needed for these proofs.
  };
  // Decode stored raw values the way tedious would hand them back (BIT →
  // boolean, everything else as parsed — varbinary already came back Buffer).
  const decode = (qualified) => (tables.get(qualified) || { rows: [], columns: [] }).rows.map((row) => {
    const entry = tables.get(qualified);
    const out = {};
    for (const col of entry.columns) {
      const v = row[col.name];
      out[col.name] = v == null ? null : (col.type === "BIT" ? (v === 1 ? true : v === 0 ? false : v) : v);
    }
    return out;
  });
  return { exec, decode, tables };
}

/**
 * pool.respond for the "restored" fake connection: dump DDL/INSERT statements
 * feed the mini executor, SELECT * reads the restored table back.
 */
function makeRestoreResponder(executor, decodeTableRef) {
  return (sql) => {
    const text = String(sql).replace(/^(?:\s|--[^\n]*\n)+/, "");
    const lower = text.toLowerCase();
    if (lower.startsWith("if object_id") || lower.startsWith("create table") || lower.startsWith("insert into")) {
      executor.exec(text);
      return { recordsets: [], rowsAffected: [1] };
    }
    if (lower.includes("select * from")) {
      const rows = executor.decode(decodeTableRef);
      return { recordsets: [rows], rowsAffected: [rows.length] };
    }
    return { recordsets: [], rowsAffected: [0] };
  };
}

const MSSQL_CHANNELS = [
  "quolldesk:mssql:connect",
  "quolldesk:mssql:disconnect",
  "quolldesk:mssql:test",
  "quolldesk:mssql:schemaTree",
  "quolldesk:mssql:tableMeta",
  "quolldesk:mssql:tableRows",
  "quolldesk:mssql:query",
  "quolldesk:mssql:applyTableChanges",
  "quolldesk:mssql:pickBackupPath",
  "quolldesk:mssql:pickRestoreFile",
  "quolldesk:mssql:backup",
  "quolldesk:mssql:restore",
];

const CONNECT_OPTS = { hostname: "sql.example.com", port: 1433, username: "sa", password: "pw" };

function setup() {
  registry._resetForTests();
  const bridge = require("./mssqlBridge.cjs");
  const fake = makeFakeMssql();
  bridge._setDriverForTests(fake);
  const handlers = new Map();
  bridge.registerHandlers({ handle: (c, fn) => handlers.set(c, fn) }, {});
  const pushes = [];
  const event = { sender: { id: 21, isDestroyed: () => false, send: (_channel, payload) => pushes.push(payload), once() {}, removeListener() {} } };
  return { bridge, fake, handlers, pushes, call: async (channel, payload) => handlers.get(channel)(event, payload) };
}

/** Poll the captured job-progress pushes until one with `phase` lands. */

function tmpSqlFile(label) {
  return path.join(os.tmpdir(), `nc-mssql-bridge-test-${label}-${process.pid}-${Math.random().toString(16).slice(2)}.sql`);
}

async function connect(call, config) {
  const conn = await call("quolldesk:mssql:connect", { ...CONNECT_OPTS, ...(config ? { config } : {}) });
  assert.equal(conn.ok, true, JSON.stringify(conn));
  return conn.data.connectionId;
}

test("registers all 12 mssql channels", () => {
  const { handlers, bridge } = setup();
  for (const channel of MSSQL_CHANNELS) {
    assert.ok(handlers.has(channel), `missing channel: ${channel}`);
  }
  bridge._setDriverForTests(undefined);
});

test("connect maps hostname/port/user/password/database and TLS config to the driver config; disconnect closes the pool", async () => {
  const { fake, bridge, call } = setup();
  const connectionId = await connect(call);
  assert.equal(fake.state.pools.length, 1);
  const cfg = fake.state.pools[0].config;
  assert.equal(cfg.server, "sql.example.com");
  assert.equal(cfg.port, 1433);
  assert.equal(cfg.user, "sa");
  assert.equal(cfg.password, "pw");
  assert.equal(cfg.database, undefined);
  // Default: TLS on, certificate verification strict.
  assert.equal(cfg.options.encrypt, true);
  assert.equal(cfg.options.trustServerCertificate, false);

  const entry = registry.getConnection(connectionId);
  assert.equal(entry.dialect, "mssql");

  // tls:false → encrypt off; tlsInsecure → trust all certificates.
  const conn2 = await call("quolldesk:mssql:connect", { ...CONNECT_OPTS, config: { database: "appdb", tls: false, tlsInsecure: true } });
  const cfg2 = fake.state.pools[1].config;
  assert.equal(cfg2.database, "appdb");
  assert.equal(cfg2.options.encrypt, false);
  assert.equal(cfg2.options.trustServerCertificate, true);

  await call("quolldesk:mssql:disconnect", { connectionId: conn2.data.connectionId });
  assert.equal(fake.state.pools[1].closed, true);
  const dead = await call("quolldesk:mssql:schemaTree", { connectionId: conn2.data.connectionId });
  assert.equal(dead.ok, false);
  assert.equal(dead.error.code, "NOT_CONNECTED");
  bridge._setDriverForTests(undefined);
});

test("connect/test validate hostname and integer port", async () => {
  const { bridge, call } = setup();
  const noHost = await call("quolldesk:mssql:connect", { port: 1433 });
  assert.equal(noHost.ok, false);
  assert.equal(noHost.error.code, "INVALID_PARAMS");
  const noPort = await call("quolldesk:mssql:connect", { hostname: "sql" });
  assert.equal(noPort.ok, false);
  const ping = await call("quolldesk:mssql:test", { hostname: "sql" });
  assert.equal(ping.ok, false);
  bridge._setDriverForTests(undefined);
});

test("test channel returns the server version and closes its probe pool", async () => {
  const { fake, bridge, call } = setup();
  const res = await call("quolldesk:mssql:test", CONNECT_OPTS);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.serverVersion, "Microsoft SQL Server 2022 (RTM-CU12) 16.0.4135.4");
  assert.equal(typeof res.data.latencyMs, "number");
  assert.equal(fake.state.pools[0].closed, true, "probe pool must be closed");
  assert.equal(registry.size(), 0, "test channel must not register a connection");
  bridge._setDriverForTests(undefined);
});

test("schemaTree: single round trip, schemas grouped with tables/views, system schemas excluded", async () => {
  const { fake, bridge, call } = setup();
  const connectionId = await connect(call);
  const queryCountBefore = fake.state.pools[0].queryLog.length;
  fake.state.pools[0].respond = makeResponder({
    listing: [
      { schema_name: "dbo", table_name: "users", kind: "U" },
      { schema_name: "dbo", table_name: "v_orders", kind: "V" },
      { schema_name: "app", table_name: null, kind: null },
    ],
  });
  const tree = await call("quolldesk:mssql:schemaTree", { connectionId });
  assert.equal(tree.ok, true, JSON.stringify(tree));
  assert.deepEqual(tree.data.databases, [
    { name: "dbo", tables: ["users"], views: ["v_orders"] },
    { name: "app", tables: [], views: [] },
  ]);
  // Single round trip: exactly one query between connect and the tree result.
  assert.equal(fake.state.pools[0].queryLog.length - queryCountBefore, 1);
  const sql = fake.state.pools[0].queryLog[queryCountBefore].sql;
  assert.ok(sql.startsWith("SELECT s.name AS schema_name"), sql);
  for (const excluded of ["guest", "INFORMATION_SCHEMA", "sys", "db_owner", "db_denydatawriter"]) {
    assert.ok(sql.includes(`'${excluded}'`), `excluded schema ${excluded} missing from: ${sql}`);
  }
  bridge._setDriverForTests(undefined);
});

test("tableMeta: columns, PK, indexes (PK index skipped), DDL, FKs, rowCount", async () => {
  const { fake, bridge, call } = setup();
  const connectionId = await connect(call);
  const pool = fake.state.pools[0];
  pool.respond = makeResponder({
    columns: [
      { COLUMN_NAME: "id", DATA_TYPE: "int", IS_NULLABLE: "NO", COLUMN_DEFAULT: null, COLUMN_COMMENT: "主键ID" },
      { COLUMN_NAME: "name", DATA_TYPE: "nvarchar", IS_NULLABLE: "YES", COLUMN_DEFAULT: null, COLUMN_COMMENT: undefined },
    ],
    pk: [{ constraint_name: "PK_users", column_name: "id" }],
    indexes: [
      { name: "idx_users_name", is_unique: false, is_primary_key: false, type_desc: "NONCLUSTERED", column_name: "name", key_ordinal: 1 },
      { name: "PK__users", is_unique: true, is_primary_key: true, type_desc: "CLUSTERED", column_name: "id", key_ordinal: 1 },
    ],
    ddl: { "dbo.users": "CREATE TABLE [dbo].[users] (\n  [id] INT NOT NULL,\n  [name] NVARCHAR(80)\n)" },
    rowCount: 42,
    fks: [{ name: "FK_users_org", column_name: "org_id", ref_column: "id", ref_table: "orgs", ref_schema: "dbo" }], trgs: [{ name: 'trg_audit', timing: 'AFTER', event: 'UPDATE', statement: 'INSERT INTO audit SELECT * FROM inserted' }], sessionsList: [{ session_id: 66, login_name: 'app_login', host_name: 'worker-host', status: 'running', seconds: 45, command: 'SELECT' }],
  });
  const meta = await call("quolldesk:mssql:tableMeta", { connectionId, table: "users", schema: "dbo" });
  assert.equal(meta.ok, true, JSON.stringify(meta));
  // Column comments (ER panel): MS_Description extended property rides along;
  // missing → null so the renderer can skip it.
  assert.deepEqual(meta.data.columns, [
    { name: "id", type: "int", nullable: false, key: "PRI", defaultValue: null, comment: "主键ID" },
    { name: "name", type: "nvarchar", nullable: true, key: null, defaultValue: null, comment: null },
  ]);
  assert.deepEqual(meta.data.primaryKey, { name: "PK_users", columns: ["id"] });
  // The PK-backed index (is_primary_key=1) must be skipped — no duplicate of primaryKey.
  assert.deepEqual(meta.data.indexes, [{ name: "idx_users_name", columns: ["name"], unique: false, method: "NONCLUSTERED" }]);
  assert.match(meta.data.ddl, /^CREATE TABLE \[dbo\]\.\[users\]/);
  assert.deepEqual(meta.data.foreignKeys, [
    { name: "FK_users_org", columns: ["org_id"], refTable: "orgs", refSchema: "dbo", refColumns: ["id"], onDelete: null, onUpdate: null },
  ]);
  assert.deepEqual(meta.data.triggers, [
    { name: "trg_audit", timing: "AFTER", event: "UPDATE", statement: "INSERT INTO audit SELECT * FROM inserted" },
  ]);
  const sessions = await call("quolldesk:mssql:sessions", { connectionId });
  assert.equal(sessions.ok, true, JSON.stringify(sessions));
  assert.deepEqual(sessions.data.sessions, [
    { id: "66", user: "app_login", app: "worker-host", state: "running / SELECT", seconds: 45, query: "" },
  ]);
  const killed = await call("quolldesk:mssql:killSession", { connectionId, pid: 66 });
  assert.equal(killed.ok, true, JSON.stringify(killed));
  assert.equal(meta.data.rowCountEstimate, 42);

  // Nine queries: columns, PK, indexes, DDL, rowCount, FKs, triggers,
  // sessions list, kill — each parameterized.
  const sqls = pool.queryLog.map((q) => q.sql);
  assert.equal(sqls.length, 9);
  assert.match(sqls[0], /INFORMATION_SCHEMA\.COLUMNS/);
  assert.match(sqls[0], /fn_listextendedproperty/, "columns query must extract the MS_Description comment");
  assert.equal(pool.queryLog[0].parameters.s, "dbo");
  assert.equal(pool.queryLog[0].parameters.t, "users");
  assert.match(sqls[1], /TABLE_CONSTRAINTS/);
  assert.match(sqls[2], /sys\.indexes/);
  assert.equal(pool.queryLog[2].parameters.qualified, "dbo.users");
  assert.match(sqls[3], /sys\.sql_modules/);
  assert.match(sqls[4], /sys\.partitions/);
  assert.match(sqls[5], /sys\.foreign_keys/);

  // No schema → SCHEMA_NAME() + bare-table OBJECT_ID.
  pool.queryLog.length = 0;
  const noSchema = await call("quolldesk:mssql:tableMeta", { connectionId, table: "users" });
  assert.equal(noSchema.ok, true);
  assert.match(pool.queryLog[0].sql, /SCHEMA_NAME\(\)/);
  assert.equal(pool.queryLog[2].parameters.qualified, "users");
  bridge._setDriverForTests(undefined);
});

test("tableRows: OFFSET/FETCH paging, ORDER BY, grid filters bound as @p placeholders", async () => {
  const { fake, bridge, call } = setup();
  const connectionId = await connect(call);
  const pool = fake.state.pools[0];
  pool.respond = makeResponder({ page: () => [{ id: 1, name: "alpha" }, { id: 2, name: "beta" }] });

  const page = await call("quolldesk:mssql:tableRows", {
    connectionId, table: "users", schema: "dbo",
    orderBy: "id", orderDir: "desc", offset: 20, limit: 100,
    filters: [
      { column: "name", op: "like", value: "alp" },
      { column: "age", op: "eq", value: "30" },
      { column: "deleted_at", op: "nul" },
    ],
  });
  assert.equal(page.ok, true, JSON.stringify(page));
  assert.deepEqual(page.data.columns, [{ name: "id" }, { name: "name" }]);
  assert.deepEqual(page.data.rows, [["1", "alpha"], ["2", "beta"]]);
  assert.equal(page.data.truncated, false);

  const q = pool.queryLog[0];
  assert.equal(
    q.sql,
    "SELECT * FROM [dbo].[users] WHERE [name] LIKE @p1 AND [age] = @p2 AND [deleted_at] IS NULL" +
    " ORDER BY [id] DESC OFFSET 20 ROWS FETCH NEXT 100 ROWS ONLY",
    q.sql,
  );
  assert.deepEqual(q.parameters, { p1: "%alp%", p2: "30" });

  // No orderBy → ORDER BY (SELECT NULL); bare table without schema.
  pool.queryLog.length = 0;
  await call("quolldesk:mssql:tableRows", { connectionId, table: "users" });
  const q2 = pool.queryLog[0];
  assert.equal(q2.sql, "SELECT * FROM [users] ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY", q2.sql);
  assert.deepEqual(q2.parameters, {});
  bridge._setDriverForTests(undefined);
});

test("applyTableChanges: single transaction (begin → statements → commit), rollback on failure", async () => {
  const { fake, bridge, call } = setup();
  const connectionId = await connect(call);
  const pool = fake.state.pools[0];
  const applied = await call("quolldesk:mssql:applyTableChanges", {
    connectionId, table: "users", schema: "dbo",
    changes: {
      updates: [{ pk: "id", pkValue: 1, column: "name", value: "ALPHA" }],
      inserts: [{ values: { id: 10, name: "delta" } }],
      deletes: [{ pk: "id", pkValue: 2 }],
    },
  });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.deepEqual(applied.data.applied, { updates: 1, inserts: 1, deletes: 1 });
  assert.equal(pool.transactions.length, 1);
  const tx = pool.transactions[0];
  assert.deepEqual(tx.events, ["begin", "commit"]);
  const stmts = pool.queryLog.filter((q) => q.onTx);
  assert.equal(stmts.length, 3);
  assert.equal(stmts[0].sql, "UPDATE [dbo].[users] SET [name] = @v WHERE [id] = @pkv");
  assert.deepEqual(stmts[0].parameters, { v: "ALPHA", pkv: "1" });
  assert.equal(stmts[1].sql, "INSERT INTO [dbo].[users] ([id], [name]) VALUES (@p1, @p2)");
  assert.deepEqual(stmts[1].parameters, { p1: "10", p2: "delta" });
  assert.equal(stmts[2].sql, "DELETE FROM [dbo].[users] WHERE [id] = @pkv");
  assert.deepEqual(stmts[2].parameters, { pkv: "2" });

  // Failure → rollback, error envelope.
  pool.queryLog.length = 0;
  pool.transactions.length = 0;
  pool.respond = (sql) => (sql.includes("INSERT")
    ? { __error: true, error: new Error("Violation of PRIMARY KEY constraint 'PK_users'") }
    : { recordsets: [], rowsAffected: [1] });
  const failed = await call("quolldesk:mssql:applyTableChanges", {
    connectionId, table: "users", schema: "dbo",
    changes: {
      updates: [{ pk: "id", pkValue: 1, column: "name", value: "X" }],
      inserts: [{ values: { id: 1, name: "dup" } }],
    },
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error.message, /PRIMARY KEY constraint/);
  assert.deepEqual(pool.transactions[0].events, ["begin", "rollback"]);
  bridge._setDriverForTests(undefined);
});

test("query: recordsets map to resultSets, rowsAffected aggregate to a trailing set, timeout + @p values", async () => {
  const { fake, bridge, call } = setup();
  const connectionId = await connect(call);
  const pool = fake.state.pools[0];

  // Two SELECT recordsets.
  pool.respond = () => ({ recordsets: [[{ id: 1 }], [{ n: "x" }]], rowsAffected: [1, 1] });
  const multi = await call("quolldesk:mssql:query", { connectionId, sql: "SELECT 1 AS id; SELECT 'x' AS n" });
  assert.equal(multi.ok, true, JSON.stringify(multi));
  assert.equal(multi.data.resultSets.length, 2);
  assert.deepEqual(multi.data.resultSets[0].columns, [{ name: "id" }]);
  assert.deepEqual(multi.data.resultSets[0].rows, [["1"]]);
  assert.deepEqual(multi.data.resultSets[1].columns, [{ name: "n" }]);
  assert.deepEqual(multi.data.resultSets[1].rows, [["x"]]);

  // Pure DML: no recordsets → one synthetic trailing result set with the aggregate.
  pool.respond = () => ({ recordsets: [], rowsAffected: [2, 3] });
  const dml = await call("quolldesk:mssql:query", { connectionId, sql: "UPDATE t SET x=1; UPDATE u SET y=2" });
  assert.deepEqual(dml.data.resultSets, [{ columns: [], rows: [], affectedRows: 5, truncated: false }]);

  // Default timeout 30s; explicit timeout forwarded; >120s clamped.
  pool.respond = () => ({ recordsets: [], rowsAffected: [1] });
  await call("quolldesk:mssql:query", { connectionId, sql: "UPDATE t SET x=1" });
  assert.equal(pool.queryLog[pool.queryLog.length - 1].overrides.requestTimeout, 30000);
  await call("quolldesk:mssql:query", { connectionId, sql: "UPDATE t SET x=1", timeoutMs: 45000 });
  assert.equal(pool.queryLog[pool.queryLog.length - 1].overrides.requestTimeout, 45000);
  await call("quolldesk:mssql:query", { connectionId, sql: "UPDATE t SET x=1", timeoutMs: 500000 });
  assert.equal(pool.queryLog[pool.queryLog.length - 1].overrides.requestTimeout, 120000);

  // values → @p1..@pN inputs.
  pool.respond = makeResponder({ page: () => [{ v: "a" }] });
  const withValues = await call("quolldesk:mssql:query", { connectionId, sql: "SELECT @p1 AS v", values: ["a"] });
  assert.equal(withValues.ok, true);
  assert.deepEqual(pool.queryLog[pool.queryLog.length - 1].parameters, { p1: "a" });
  bridge._setDriverForTests(undefined);
});

test("backup (table scope): OBJECT_ID drop guard, sql_modules DDL, PK keyset pages, bracket-quoted INSERTs, dialect push", async () => {
  const { fake, bridge, pushes, call } = setup();
  const connectionId = await connect(call, { database: "appdb" });
  const pool = fake.state.pools[0];
  const page1 = Array.from({ length: 500 }, (_, i) => ({ id: i + 1, name: `n${i}` }));
  const page2 = [{ id: 501, name: "O'Brien" }, { id: 502, name: "a\\b" }];
  pool.respond = makeResponder({
    listing: [
      { schema_name: "dbo", table_name: "users", kind: "U" },
      { schema_name: "dbo", table_name: "v_orders", kind: "V" },
      { schema_name: "app", table_name: "log", kind: "U" },
    ],
    pk: [{ constraint_name: "PK_users", column_name: "id" }],
    ddl: {
      "dbo.users": "CREATE TABLE [dbo].[users] (\n  [id] INT NOT NULL,\n  [name] NVARCHAR(80)\n)",
    },
    page: (sql) => (sql.includes(" WHERE ") ? page2 : page1),
  });
  const outFile = tmpSqlFile("backup");
  try {
    const res = await call("quolldesk:mssql:backup", { connectionId, scope: "table", schema: "dbo", table: "users", includeData: true, outFile });
    assert.equal(res.ok, true, JSON.stringify(res));
    const done = await waitForPush(pushes, "done");
    assert.equal(done.dialect, "mssql");
    const dump = fs.readFileSync(outFile, "utf8");
    assert.ok(dump.includes("-- Dialect: mssql"), dump.slice(0, 400));
    assert.ok(dump.includes("-- Scope: table dbo.users"), dump.slice(0, 400));
    assert.ok(dump.includes("IF OBJECT_ID(N'[dbo].[users]', 'U') IS NOT NULL DROP TABLE [dbo].[users];"), dump);
    assert.ok(dump.includes("CREATE TABLE [dbo].[users]"), dump);
    assert.ok(dump.includes("INSERT INTO [dbo].[users] ([id], [name]) VALUES"), dump);
    assert.ok(dump.includes("(1, 'n0')"), dump);
    assert.ok(dump.includes("(501, 'O''Brien')"), dump);
    assert.ok(dump.includes("(502, 'a\\b')"), dump, "mssql reads backslashes literally — no doubling");
    assert.ok(!dump.includes("app"), "table scope must not dump other schemas' tables");

    // Keyset paging: second page resumes after the last PK value.
    const pageSqls = pool.queryLog.filter((q) => q.sql.includes("SELECT * FROM")).map((q) => q.sql);
    assert.equal(pageSqls.length, 2);
    assert.equal(
      pageSqls[0],
      "SELECT * FROM [dbo].[users] ORDER BY [id] OFFSET 0 ROWS FETCH NEXT 500 ROWS ONLY",
      pageSqls[0],
    );
    assert.equal(
      pageSqls[1],
      "SELECT * FROM [dbo].[users] WHERE ([id] > 500) ORDER BY [id] OFFSET 0 ROWS FETCH NEXT 500 ROWS ONLY",
      pageSqls[1],
    );
    assert.ok(!pool.queryLog.some((q) => q.sql.includes("v_orders") && q.sql.includes("SELECT definition")), "table scope skips views");
  } finally {
    await call("quolldesk:mssql:disconnect", { connectionId });
    bridge._setDriverForTests(undefined);
    fs.unlink(outFile, () => {});
  }
});

test("backup (database scope, DDL only): tables then views from sys.sql_modules", async () => {
  const { fake, bridge, pushes, call } = setup();
  const connectionId = await connect(call, { database: "appdb" });
  const pool = fake.state.pools[0];
  pool.respond = makeResponder({
    listing: [
      { schema_name: "dbo", table_name: "users", kind: "U" },
      { schema_name: "dbo", table_name: "v_orders", kind: "V" },
      { schema_name: "app", table_name: "log", kind: "U" },
    ],
    ddl: {
      "dbo.users": "CREATE TABLE [dbo].[users] (\n  [id] INT NOT NULL\n)",
      "app.log": "CREATE TABLE [app].[log] (\n  [msg] NVARCHAR(MAX)\n)",
      "dbo.v_orders": "CREATE VIEW [dbo].[v_orders] AS SELECT * FROM [dbo].[users]",
    },
  });
  const outFile = tmpSqlFile("backup-ddl");
  try {
    const res = await call("quolldesk:mssql:backup", { connectionId, scope: "database", includeData: false, outFile });
    assert.equal(res.ok, true, JSON.stringify(res));
    await waitForPush(pushes, "done");
    const dump = fs.readFileSync(outFile, "utf8");
    assert.ok(dump.includes("DROP TABLE [dbo].[users];"), dump);
    assert.ok(dump.includes("CREATE TABLE [dbo].[users]"), dump);
    assert.ok(dump.includes("DROP TABLE [app].[log];"), dump);
    assert.ok(dump.includes("CREATE TABLE [app].[log]"), dump);
    assert.ok(!dump.includes("INSERT INTO"), "includeData=false must skip data pages");
    // View block comes after every table block.
    const usersIdx = dump.indexOf("CREATE TABLE [dbo].[users]");
    const logIdx = dump.indexOf("CREATE TABLE [app].[log]");
    const viewIdx = dump.indexOf("DROP VIEW [dbo].[v_orders]");
    const viewDefIdx = dump.indexOf("CREATE VIEW [dbo].[v_orders]");
    assert.ok(usersIdx >= 0 && logIdx >= 0 && viewIdx > logIdx && viewDefIdx > viewIdx, dump);
    assert.ok(dump.includes("IF OBJECT_ID(N'[dbo].[v_orders]', 'V') IS NOT NULL DROP VIEW [dbo].[v_orders];"), dump);
  } finally {
    await call("quolldesk:mssql:disconnect", { connectionId });
    bridge._setDriverForTests(undefined);
    fs.unlink(outFile, () => {});
  }
});

test("backup: BIT/varbinary columns render T-SQL literals (1/0, 0x..) and restore round-trips", async () => {
  const { fake, bridge, pushes, call } = setup();
  const connectionId = await connect(call, { database: "appdb" });
  const pool = fake.state.pools[0];
  const data1 = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const data2 = Buffer.from([0x00, 0xff]);
  pool.respond = makeResponder({
    listing: [{ schema_name: "dbo", table_name: "bits", kind: "U" }],
    pk: [{ constraint_name: "PK_bits", column_name: "id" }],
    ddl: { "dbo.bits": "CREATE TABLE [dbo].[bits] (\n  [id] INT NOT NULL,\n  [flag] BIT NOT NULL,\n  [data] VARBINARY(MAX)\n)" },
    page: () => [
      { id: 1, flag: true, data: data1 },
      { id: 2, flag: false, data: data2 },
    ],
  });
  const outFile = tmpSqlFile("backup-bits");
  try {
    const res = await call("quolldesk:mssql:backup", { connectionId, scope: "table", schema: "dbo", table: "bits", includeData: true, outFile });
    assert.equal(res.ok, true, JSON.stringify(res));
    await waitForPush(pushes, "done");
    const dump = fs.readFileSync(outFile, "utf8");
    // BIT → 1/0 (never TRUE/FALSE); varbinary → bare 0x hex (never pg's '\x..'::bytea).
    assert.ok(dump.includes("(1, 1, 0xDEADBEEF)"), dump);
    assert.ok(dump.includes("(2, 0, 0x00FF)"), dump);
    assert.ok(!/\bTRUE\b|\bFALSE\b/.test(dump), dump);
    assert.ok(!dump.includes("::bytea"), dump);

    // Roundtrip proof: restore the dump into a fresh connection through the
    // bridge's restore channel, then read the values back via tableRows.
    pushes.length = 0; // drop the backup job's pushes so waitForPush sees the restore's
    const executor = makeMiniExecutor();
    const conn2 = await call("quolldesk:mssql:connect", { ...CONNECT_OPTS, config: { database: "restored" } });
    fake.state.pools[1].respond = makeRestoreResponder(executor, "[dbo].[bits]");
    const restore = await call("quolldesk:mssql:restore", { connectionId: conn2.data.connectionId, inFile: outFile });
    assert.equal(restore.ok, true, JSON.stringify(restore));
    await waitForPush(pushes, "done");
    const rows = await call("quolldesk:mssql:tableRows", { connectionId: conn2.data.connectionId, table: "bits", schema: "dbo" });
    assert.equal(rows.ok, true, JSON.stringify(rows));
    // serializeCellValue: BIT decodes to true/false → "true"/"false"; varbinary
    // decodes to Buffer → JSON text. Equal to the original source values.
    assert.deepEqual(rows.data.rows, [
      ["1", "true", JSON.stringify({ type: "Buffer", data: [222, 173, 190, 239] })],
      ["2", "false", JSON.stringify({ type: "Buffer", data: [0, 255] })],
    ]);
    await call("quolldesk:mssql:disconnect", { connectionId: conn2.data.connectionId });
  } finally {
    await call("quolldesk:mssql:disconnect", { connectionId });
    bridge._setDriverForTests(undefined);
    fs.unlink(outFile, () => {});
  }
});

test("backup: composite PK keyset uses per-column OR-chains and every row lands", async () => {
  const { fake, bridge, pushes, call } = setup();
  const connectionId = await connect(call, { database: "appdb" });
  const pool = fake.state.pools[0];
  // 520 rows (a = 1..26, b = 1..20): page 1 fills DUMP_PAGE_SIZE=500, the rest
  // must come back via a second (keyset) page.
  const fullRows = [];
  for (let k = 0; k < 520; k += 1) fullRows.push({ a: Math.floor(k / 20) + 1, b: (k % 20) + 1, tag: `r${k}` });
  // Evaluate the generated 2-column keyset predicate with real T-SQL
  // semantics — a wrong predicate here would fail (or loop) the backup.
  const evalKeyset = (sql) => {
    const m = sql.match(/WHERE \(\[([a-z_]+)\] > (-?\d+) OR \(\[([a-z_]+)\] = (-?\d+) AND \[([a-z_]+)\] > (-?\d+)\)\)/i);
    if (!m) throw new Error(`unexpected keyset predicate: ${sql}`);
    const [, c1, v1, e1, ev1, c2, v2] = m;
    if (!(c1 === "a" && e1 === "a" && c2 === "b")) throw new Error(`predicate columns out of order: ${sql}`);
    const x1 = Number(v1), x2 = Number(ev1);
    return fullRows.filter((r) => r[c1] > x1 || (r[e1] === x1 && r[c2] > x2));
  };
  pool.respond = makeResponder({
    listing: [{ schema_name: "dbo", table_name: "c_pk", kind: "U" }],
    pk: [
      { constraint_name: "PK_cpk", column_name: "a" },
      { constraint_name: "PK_cpk", column_name: "b" },
    ],
    ddl: { "dbo.c_pk": "CREATE TABLE [dbo].[c_pk] (\n  [a] INT NOT NULL,\n  [b] INT NOT NULL,\n  [tag] NVARCHAR(40)\n)" },
    page: (sql) => (sql.includes(" WHERE ") ? evalKeyset(sql).slice(0, 500) : fullRows.slice(0, 500)),
  });
  const outFile = tmpSqlFile("backup-cpk");
  try {
    const res = await call("quolldesk:mssql:backup", { connectionId, scope: "table", schema: "dbo", table: "c_pk", includeData: true, outFile });
    assert.equal(res.ok, true, JSON.stringify(res));
    await waitForPush(pushes, "done");

    // Exactly two data pages; the second resumes via the OR-chain predicate
    // (no row-value comparison — T-SQL has none).
    const pageSqls = pool.queryLog.filter((q) => q.sql.includes("SELECT * FROM")).map((q) => q.sql);
    assert.equal(pageSqls.length, 2, JSON.stringify(pageSqls));
    assert.match(pageSqls[0], /ORDER BY \[a\], \[b\] OFFSET 0 ROWS FETCH NEXT 500 ROWS ONLY$/, pageSqls[0]);
    assert.match(pageSqls[1], /WHERE \(\[a\] > 25 OR \(\[a\] = 25 AND \[b\] > 20\)\) ORDER BY \[a\], \[b\]/, pageSqls[1]);
    assert.ok(!pageSqls[1].includes(") > ("), "row-value comparison must not be generated");

    const dump = fs.readFileSync(outFile, "utf8");
    assert.ok(dump.includes("(25, 20, 'r499')"), dump);
    assert.ok(dump.includes("(26, 20, 'r519')"), dump);
    const insertedRows = (dump.match(/\(\d+, \d+, 'r\d+'/g) || []).length;
    assert.equal(insertedRows, 520, `expected 520 dumped rows, got ${insertedRows}`);

    // Roundtrip proof: restore into a fresh connection, read all rows back.
    pushes.length = 0; // drop the backup job's pushes so waitForPush sees the restore's
    const executor = makeMiniExecutor();
    const conn2 = await call("quolldesk:mssql:connect", { ...CONNECT_OPTS, config: { database: "restored" } });
    fake.state.pools[1].respond = makeRestoreResponder(executor, "[dbo].[c_pk]");
    const restore = await call("quolldesk:mssql:restore", { connectionId: conn2.data.connectionId, inFile: outFile });
    assert.equal(restore.ok, true, JSON.stringify(restore));
    await waitForPush(pushes, "done");
    const rows = await call("quolldesk:mssql:tableRows", { connectionId: conn2.data.connectionId, table: "c_pk", schema: "dbo", limit: 1000 });
    assert.equal(rows.ok, true, JSON.stringify(rows));
    assert.equal(rows.data.rows.length, 520, "all 520 rows must land in the restored table");
    assert.deepEqual(rows.data.rows[0], ["1", "1", "r0"]);
    assert.deepEqual(rows.data.rows[499], ["25", "20", "r499"]);
    assert.deepEqual(rows.data.rows[519], ["26", "20", "r519"]);
    await call("quolldesk:mssql:disconnect", { connectionId: conn2.data.connectionId });
  } finally {
    await call("quolldesk:mssql:disconnect", { connectionId });
    bridge._setDriverForTests(undefined);
    fs.unlink(outFile, () => {});
  }
});

test("backup/restore: object names containing quotes survive the OBJECT_ID guard literals", async () => {
  const { fake, bridge, pushes, call } = setup();
  const connectionId = await connect(call, { database: "appdb" });
  const pool = fake.state.pools[0];
  pool.respond = makeResponder({
    listing: [
      { schema_name: "dbo", table_name: "weird'name", kind: "U" },
      { schema_name: "dbo", table_name: "v'w", kind: "V" },
    ],
    ddl: {
      "dbo.weird'name": "CREATE TABLE [dbo].[weird'name] (\n  [id] INT NOT NULL\n)",
      "dbo.v'w": "CREATE VIEW [dbo].[v'w] AS SELECT 1 AS one",
    },
  });
  const outFile = tmpSqlFile("backup-quote");
  try {
    const res = await call("quolldesk:mssql:backup", { connectionId, scope: "database", includeData: false, outFile });
    assert.equal(res.ok, true, JSON.stringify(res));
    await waitForPush(pushes, "done");
    const dump = fs.readFileSync(outFile, "utf8");
    // The N'' guard literal escapes the quote (the bracket name outside stays raw).
    assert.ok(dump.includes("IF OBJECT_ID(N'[dbo].[weird''name]', 'U') IS NOT NULL DROP TABLE [dbo].[weird'name];"), dump);
    assert.ok(dump.includes("IF OBJECT_ID(N'[dbo].[v''w]', 'V') IS NOT NULL DROP VIEW [dbo].[v'w];"), dump);
    assert.ok(!dump.includes("N'[dbo].[weird'name]'"), "unescaped quote would terminate the OBJECT_ID literal");

    // Roundtrip: restore executes the guarded drop (un-escaping the N literal
    // back to the real key) and the CREATE TABLE.
    pushes.length = 0; // drop the backup job's pushes so waitForPush sees the restore's
    const executor = makeMiniExecutor();
    executor.tables.set("[dbo].[weird'name]", { columns: [{ name: "stale", type: "INT" }], rows: [] });
    const conn2 = await call("quolldesk:mssql:connect", { ...CONNECT_OPTS, config: { database: "restored" } });
    fake.state.pools[1].respond = makeRestoreResponder(executor, "[dbo].[weird'name]");
    const restore = await call("quolldesk:mssql:restore", { connectionId: conn2.data.connectionId, inFile: outFile });
    assert.equal(restore.ok, true, JSON.stringify(restore));
    await waitForPush(pushes, "done");
    const entry = executor.tables.get("[dbo].[weird'name]");
    assert.ok(entry, "quoted-name table must exist after restore");
    assert.deepEqual(entry.columns, [{ name: "id", type: "INT" }]);
    await call("quolldesk:mssql:disconnect", { connectionId: conn2.data.connectionId });
  } finally {
    await call("quolldesk:mssql:disconnect", { connectionId });
    bridge._setDriverForTests(undefined);
    fs.unlink(outFile, () => {});
  }
});

test("restore: splitSqlStatements mssql mode + sequential exec with dialect pushes", async () => {
  const { fake, bridge, pushes, call } = setup();
  const connectionId = await connect(call);
  const pool = fake.state.pools[0];
  const executed = [];
  pool.respond = (sql) => { executed.push(sql); return { recordsets: [], rowsAffected: [1] }; };
  const inFile = tmpSqlFile("restore");
  const script = [
    "-- QuollDesk dump header",
    "IF OBJECT_ID(N'[t]', 'U') IS NOT NULL DROP TABLE [t];",
    "INSERT INTO [t] VALUES ('a;b');", // `;` inside the string must not split
  ].join("\n");
  try {
    fs.writeFileSync(inFile, script, "utf8");
    const res = await call("quolldesk:mssql:restore", { connectionId, inFile });
    assert.equal(res.ok, true, JSON.stringify(res));
    const done = await waitForPush(pushes, "done");
    assert.equal(done.dialect, "mssql");
    assert.match(done.message, /2 statements executed/);
    // readOnlySql's mssql splitter keeps in-statement comment text (T-SQL
    // executes leading `--` comments fine); `;` inside a string never splits.
    assert.deepEqual(executed, [
      "-- QuollDesk dump header\nIF OBJECT_ID(N'[t]', 'U') IS NOT NULL DROP TABLE [t]",
      "INSERT INTO [t] VALUES ('a;b')",
    ]);
    const progress = pushes.find((p) => p.phase === "restore");
    assert.equal(progress.dialect, "mssql");
    assert.equal(progress.total, 2);
  } finally {
    await call("quolldesk:mssql:disconnect", { connectionId });
    bridge._setDriverForTests(undefined);
    fs.unlink(inFile, () => {});
  }
});

test("runLimitedQuery: runs one statement and truncates rows at maxRows (default 200)", async () => {
  const { fake, bridge, call } = setup();
  const connectionId = await connect(call);
  const pool = fake.state.pools[0];
  const rows250 = Array.from({ length: 250 }, (_, i) => ({ id: i + 1, name: `r${i}` }));
  pool.respond = makeResponder({ page: () => rows250 });
  const { runLimitedQuery } = bridge;

  const limited = await runLimitedQuery(pool, "SELECT * FROM big");
  assert.equal(limited.rows.length, 200, "default maxRows is 200");
  assert.equal(limited.truncated, true);
  assert.equal(limited.rowCount, 250);
  assert.deepEqual(limited.columns, [{ name: "id" }, { name: "name" }]);
  assert.deepEqual(limited.rows[0], ["1", "r0"]);

  const capped = await runLimitedQuery(pool, "SELECT * FROM big", 10);
  assert.equal(capped.rows.length, 10);
  assert.equal(capped.truncated, true);

  const small = await runLimitedQuery(pool, "SELECT * FROM big", 300);
  assert.equal(small.rows.length, 250);
  assert.equal(small.truncated, false);
  bridge._setDriverForTests(undefined);
});

test("pickBackupPath / pickRestoreFile use the injected dialog", async () => {
  const { bridge, call } = setup();
  const fakeDialog = {
    showSaveDialog: async (_owner, opts) => {
      assert.deepEqual(opts.filters, [{ name: "SQL", extensions: ["sql"] }]);
      return { canceled: false, filePath: "/picked/out.sql" };
    },
    showOpenDialog: async (_owner, opts) => {
      assert.ok(opts.properties.includes("openFile"));
      return { canceled: false, filePaths: ["/picked/dump.sql"] };
    },
  };
  bridge._setDialogForTests(fakeDialog);
  try {
    const backupPath = await call("quolldesk:mssql:pickBackupPath", { defaultName: "dump.sql" });
    assert.equal(backupPath.ok, true, JSON.stringify(backupPath));
    assert.equal(backupPath.data.path, "/picked/out.sql");
    const restoreFile = await call("quolldesk:mssql:pickRestoreFile");
    assert.equal(restoreFile.ok, true, JSON.stringify(restoreFile));
    assert.equal(restoreFile.data.path, "/picked/dump.sql");
  } finally {
    bridge._setDialogForTests(null);
  }
  bridge._setDriverForTests(undefined);
});
