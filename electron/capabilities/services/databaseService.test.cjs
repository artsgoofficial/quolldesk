"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const registry = require("../../bridges/dbCommon/connectionRegistry.cjs");
const mysqlBridge = require("../../bridges/mysqlBridge.cjs");
const pgBridge = require("../../bridges/pgBridge.cjs");
const redisBridge = require("../../bridges/redisBridge.cjs");

// ---- fakes ----

/** mysql conn compatible with the real runQuery (event mode) + callback form. */
function makeFakeMysqlConn(route) {
  const calls = [];
  const conn = {
    calls,
    config: { database: "shop" },
    query(sqlOrObj, valuesOrCb) {
      const isObjForm = sqlOrObj && typeof sqlOrObj === "object";
      calls.push(isObjForm ? sqlOrObj.sql : sqlOrObj);
      // mysql2 callback form (service control statements: txn begin/end)
      if (!isObjForm && typeof valuesOrCb === "function") {
        setImmediate(() => valuesOrCb(null, { affectedRows: 0 }));
        return undefined;
      }
      const emitter = new EventEmitter();
      emitter.destroy = () => {};
      setImmediate(() => {
        try {
          const out = route(String(sqlOrObj.sql), sqlOrObj.values);
          if (out.error) { emitter.emit("error", out.error); return; }
          if (out.fields) emitter.emit("fields", out.fields);
          for (const row of out.rows || []) emitter.emit("result", row);
          if (out.okPacket) emitter.emit("result", out.okPacket);
          emitter.emit("end");
        } catch (err) { emitter.emit("error", err); }
      });
      return emitter;
    },
    end() {}, destroy() {},
  };
  return conn;
}

/** pg client compatible with the real runLimitedQuery (downgrade path). */
function makeFakePgClient() {
  const calls = [];
  const client = {
    calls,
    async query(textOrObj) {
      const text = typeof textOrObj === "string" ? textOrObj : String(textOrObj?.text ?? textOrObj);
      calls.push(text);
      if (/^BEGIN READ ONLY$/i.test(text) || /^ROLLBACK$/i.test(text)) return { rows: [] };
      if (text.includes(";")) {
        return [{ rows: [{ id: 1 }] }, { rows: [{ marker: "last" }], rowCount: 1, command: "SELECT" }];
      }
      if (/information_schema\.tables/i.test(text)) {
        return { rows: [{ schema: "public", name: "users", kind: "BASE TABLE" }], fields: [{ name: "schema" }, { name: "name" }, { name: "kind" }] };
      }
      if (/information_schema\.columns/i.test(text)) {
        return { rows: [{ column_name: "id", data_type: "integer", is_nullable: "NO", column_default: null }], fields: [{ name: "column_name" }] };
      }
      if (/table_constraints/i.test(text)) {
        return { rows: [{ column_name: "id" }], fields: [{ name: "column_name" }] };
      }
      if (/^UPDATE/i.test(text)) return { rows: [], rowCount: 3, command: "UPDATE" };
      if (/missing/i.test(text)) throw new Error('relation "missing" does not exist');
      if (/^SELECT/i.test(text)) {
        return { rows: [{ id: 1, name: "a" }], fields: [{ name: "id" }, { name: "name" }] };
      }
      return { rows: [], fields: [] };
    },
  };
  return client;
}

function makeFakePgDriver() {
  return {
    QueryStream: class FakeQueryStream {
      constructor(text, values) { this.text = text; this.values = values; }
    },
  };
}

/** redis dial ({kind, client}) compatible with the real nodeFor. */
function makeFakeRedisDial() {
  const commands = [];
  const client = {
    commands,
    async sendCommand(tokens) {
      commands.push(tokens.map(String));
      const head = String(tokens[0]).toUpperCase();
      if (head === "SCAN") return ["17", ["user:1", "user:2"]];
      if (head === "TYPE") return String(tokens[1]) === "missing" ? "none" : "string";
      if (head === "TTL") return 60;
      if (head === "GET") return "hello";
      if (head === "SET") return "OK";
      if (head === "EXPIRE" || head === "PERSIST") return 1;
      if (head === "DEL") return 1;
      if (head === "RENAME") return "OK";
      if (head === "ZADD") return 1;
      throw new Error("ERR unknown command");
    },
  };
  return { kind: "single", client };
}

// ---- setup ----

function setup() {
  registry._resetForTests();
  const mysqlConn = makeFakeMysqlConn((sql) => {
    if (/unknown_col/i.test(sql)) return { error: new Error("Unknown column 'x' in 'field list'") };
    if (/information_schema\.tables/i.test(sql)) return { fields: [{ name: "schema" }, { name: "name" }, { name: "kind" }], rows: [{ schema: "shop", name: "users", kind: "BASE TABLE" }] };
    if (/information_schema\.columns/i.test(sql)) return { fields: [{ name: "column_name" }], rows: [{ column_name: "id", data_type: "int", is_nullable: "NO", column_default: null, column_key: "PRI" }] };
    if (/^SELECT/i.test(sql)) return { fields: [{ name: "id" }], rows: [{ id: 1 }] };
    if (/^UPDATE/i.test(sql)) return { okPacket: { affectedRows: 4, insertId: 0 } };
    return { fields: null, rows: [], okPacket: { affectedRows: 1 } };
  });
  const pgClient = makeFakePgClient();
  const redisDial = makeFakeRedisDial();

  pgBridge._setDriverForTests(makeFakePgDriver());

  const mysqlId = registry.registerConnection({
    dialect: "mysql", senderId: 1, client: { conn: mysqlConn }, close() {},
    meta: { hostname: "mysql.local", port: 3306, database: "shop", username: "app" },
  });
  const pgId = registry.registerConnection({
    dialect: "postgresql", senderId: 1, client: { client: pgClient }, close() {},
    meta: { hostname: "pg.local", port: 5432, database: "artgo", username: "sunkejun" },
  });
  const redisId = registry.registerConnection({
    dialect: "redis", senderId: 1, client: redisDial, close() {},
    meta: { hostname: "127.0.0.1", port: 6379, database: null, username: null },
  });

  const { createDatabaseService } = require("./databaseService.cjs");
  const service = createDatabaseService({ registry, mysqlBridge, pgBridge, redisBridge });
  return { service, registry, mysqlConn, pgClient, redisDial, ids: { mysqlId, pgId, redisId } };
}

// ---- tests ----

test("listConnections exposes open connections with meta, never secrets", async () => {
  const { service, ids } = setup();
  const all = await service.listConnections({});
  assert.equal(all.ok, true);
  assert.equal(all.connections.length, 3);
  const mysqlRow = all.connections.find((c) => c.connectionId === ids.mysqlId);
  assert.deepEqual(mysqlRow, {
    connectionId: ids.mysqlId, dialect: "mysql",
    hostname: "mysql.local", port: 3306, database: "shop", username: "app",
  });
  assert.ok(!("client" in mysqlRow) && !("password" in mysqlRow));
  const redisOnly = await service.listConnections({ dialect: "redis" });
  assert.equal(redisOnly.connections.length, 1);
  assert.equal(redisOnly.connections[0].connectionId, ids.redisId);
});

test("every tool rejects an unknown connectionId with NOT_CONNECTED", async () => {
  const { service } = setup();
  const ghost = "00000000-0000-0000-0000-000000000000";
  for (const [label, run] of [
    ["query", () => service.query({ connectionId: ghost, sql: "SELECT 1" })],
    ["execute", () => service.execute({ connectionId: ghost, sql: "UPDATE t SET a=1" })],
    ["schema", () => service.schema({ connectionId: ghost })],
    ["scan", () => service.redisScanKeys({ connectionId: ghost })],
    ["get", () => service.redisGetKey({ connectionId: ghost, key: "k" })],
    ["edit", () => service.redisEditKey({ connectionId: ghost, action: "delete", key: "k" })],
    ["command", () => service.redisCommand({ connectionId: ghost, command: "PING" })],
  ]) {
    const result = await run();
    assert.equal(result.ok, false, label);
    assert.equal(result.code, "NOT_CONNECTED", label);
  }
  const noParams = await service.query({ sql: "SELECT 1" });
  assert.equal(noParams.code, "INVALID_PARAMS");
});

test("dialect mismatch returns INVALID_PARAMS", async () => {
  const { service, ids } = setup();
  const result = await service.query({ connectionId: ids.redisId, sql: "SELECT 1" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_PARAMS");
});

test("query rejects write statements with READ_ONLY_VIOLATION", async () => {
  const { service, ids } = setup();
  const result = await service.query({ connectionId: ids.mysqlId, sql: "DELETE FROM t" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "READ_ONLY_VIOLATION");
  assert.match(result.error, /database_execute/);
});

test("mysql query wraps in a READ ONLY transaction (begin → sql → rollback)", async () => {
  const { service, ids, mysqlConn } = setup();
  const result = await service.query({ connectionId: ids.mysqlId, sql: "SELECT id FROM t" });
  assert.equal(result.ok, true);
  assert.deepEqual(mysqlConn.calls, ["START TRANSACTION READ ONLY", "SELECT id FROM t", "ROLLBACK"]);
  const rs = result.resultSets[0];
  assert.deepEqual(rs.columns, [{ name: "id" }]);
  assert.deepEqual(rs.rows, [{ id: "1" }]); // serializeCellValue stringifies like the grid path
  assert.equal(rs.truncated, false);
  assert.equal(result.readOnly, true);
  assert.equal(typeof result.executionTimeMs, "number");
});

test("pg query wraps in BEGIN READ ONLY … ROLLBACK", async () => {
  const { service, ids, pgClient } = setup();
  const result = await service.query({ connectionId: ids.pgId, sql: "SELECT id FROM t" });
  assert.equal(result.ok, true);
  assert.equal(pgClient.calls[0], "BEGIN READ ONLY");
  assert.equal(pgClient.calls[pgClient.calls.length - 1], "ROLLBACK");
  // cellify stringifies values on the pg path (same as the workbench grid)
  assert.deepEqual(result.resultSets[0].rows, [{ id: "1", name: "a" }]);
});

test("pg multi-statement query returns the last statement's rows", async () => {
  const { service, ids, pgClient } = setup();
  const result = await service.query({ connectionId: ids.pgId, sql: "SELECT 1; SELECT marker FROM x" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.resultSets[0].rows, [{ marker: "last" }]);
  assert.equal(pgClient.calls[0], "BEGIN READ ONLY");
});

test("driver errors map through classifyDriverError", async () => {
  const { service, ids } = setup();
  const mysqlErr = await service.query({ connectionId: ids.mysqlId, sql: "SELECT unknown_col FROM t" });
  assert.equal(mysqlErr.ok, false);
  assert.equal(mysqlErr.code, "QUERY_ERROR");
  const pgErr = await service.execute({ connectionId: ids.pgId, sql: "SELECT * FROM missing" });
  assert.equal(pgErr.ok, false);
  assert.equal(pgErr.code, "QUERY_ERROR");
});

test("execute returns mysql affectedRows from okPacket", async () => {
  const { service, ids, mysqlConn } = setup();
  const result = await service.execute({ connectionId: ids.mysqlId, sql: "UPDATE t SET a=1" });
  assert.equal(result.ok, true);
  assert.equal(result.resultSets[0].affectedRows, 4);
  assert.deepEqual(mysqlConn.calls, ["UPDATE t SET a=1"]); // no txn wrapper
});

test("pg execute preserves rowCount", async () => {
  const { service, ids } = setup();
  const result = await service.execute({ connectionId: ids.pgId, sql: "UPDATE t SET a=1" });
  assert.equal(result.ok, true);
  assert.equal(result.rowCount, 3);
  assert.equal(result.command, "UPDATE");
});

test("schema lists tables (mysql) and columns+pk (pg)", async () => {
  const { service, ids } = setup();
  const tables = await service.schema({ connectionId: ids.mysqlId });
  assert.deepEqual(tables.tables, [{ schema: "shop", name: "users", kind: "BASE TABLE" }]);
  const columns = await service.schema({ connectionId: ids.pgId, table: "users" });
  assert.deepEqual(columns.primaryKey, ["id"]);
  assert.equal(columns.columns[0].column_name, "id");
});

test("chat scope narrowing denies out-of-scope connections", async () => {
  const { registry } = setup();
  const { createDatabaseService } = require("./databaseService.cjs");
  const scoped = createDatabaseService({
    registry,
    getScopedDbConnectionIds: () => new Set(["allowed-id"]),
  });
  const mysqlId = registry.listConnections().find((c) => c.dialect === "mysql").id;
  const result = await scoped.query({ connectionId: mysqlId, sql: "SELECT 1", chatSessionId: "chat-1" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PERMISSION_DENIED");
  // in-scope passes the gate (fails later only if the connection is missing)
  const allowed = await scoped.query({ connectionId: "allowed-id", sql: "SELECT 1", chatSessionId: "chat-1" });
  assert.equal(allowed.code, "NOT_CONNECTED");
});

test("redis_command blocks console-blocked commands and runs raw commands", async () => {
  const { service, ids, redisDial } = setup();
  const blocked = await service.redisCommand({ connectionId: ids.redisId, command: "SUBSCRIBE news" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "INVALID_PARAMS");
  assert.equal(redisDial.client.commands.length, 0);

  const ok = await service.redisCommand({ connectionId: ids.redisId, command: "GET foo" });
  assert.equal(ok.ok, true);
  assert.equal(ok.reply, "hello");
  assert.deepEqual(redisDial.client.commands[0], ["GET", "foo"]);
});

test("redis_scan_keys pages with cursor and pattern wrapping", async () => {
  const { service, ids, redisDial } = setup();
  const page1 = await service.redisScanKeys({ connectionId: ids.redisId, match: "user" });
  assert.equal(page1.ok, true);
  assert.equal(page1.cursor, "17");
  assert.deepEqual(page1.keys.map((k) => k.name), ["user:1", "user:2"]);
  assert.deepEqual(redisDial.client.commands[0], ["SCAN", "0", "MATCH", "*user*", "COUNT", "200"]);
  const page2 = await service.redisScanKeys({ connectionId: ids.redisId, cursor: "17", count: 50 });
  assert.deepEqual(redisDial.client.commands[1], ["SCAN", "17", "MATCH", "*", "COUNT", "50"]);
});

test("redis_key_get reads type/ttl/value and reports missing keys", async () => {
  const { service, ids } = setup();
  const hit = await service.redisGetKey({ connectionId: ids.redisId, key: "greeting" });
  assert.equal(hit.ok, true);
  assert.equal(hit.type, "string");
  assert.equal(hit.ttlSeconds, 60);
  assert.equal(hit.value, "hello");
  assert.equal(hit.exists, true);
  const miss = await service.redisGetKey({ connectionId: ids.redisId, key: "missing" });
  assert.equal(miss.ok, true);
  assert.equal(miss.exists, false);
});

// ---- new-dialect fakes / helpers ----

/**
 * mssql pool compatible with mssqlBridge.runLimitedQuery / runQuery, modelling
 * tedious's min:0/max:10 pool with >1 underlying connections: every
 * pool.request() round-robins to the NEXT connection, so separate pool
 * requests can land on different connections. A Transaction from
 * makeFakeMssqlTxDriver instead leases ONE connection at begin() and holds it
 * until rollback/commit — the exact binding runReadOnlyBatch relies on.
 */
function makeFakeMssqlPool() {
  const calls = [];
  const connections = Array.from({ length: 3 }, () => ({ calls: [], leasedBy: null }));
  let next = 0;
  const respond = (text) => {
    if (/^BEGIN TRANSACTION$/i.test(text) || /^ROLLBACK$/i.test(text)) return { recordsets: [], rowsAffected: [0] };
    if (/INFORMATION_SCHEMA\.TABLES/i.test(text)) {
      return { recordsets: [[{ schema: "dbo", name: "users", kind: "BASE TABLE" }]], rowsAffected: [0] };
    }
    if (/INFORMATION_SCHEMA\.COLUMNS/i.test(text)) {
      return { recordsets: [[{ COLUMN_NAME: "id", DATA_TYPE: "int", IS_NULLABLE: "NO", COLUMN_DEFAULT: null }]], rowsAffected: [0] };
    }
    if (/TABLE_CONSTRAINTS/i.test(text)) {
      return { recordsets: [[{ column_name: "id" }]], rowsAffected: [0] };
    }
    if (/^SELECT/i.test(text)) return { recordsets: [[{ id: 1, name: "a" }]], rowsAffected: [0] };
    return { recordsets: [], rowsAffected: [3] };
  };
  const pool = {
    calls,
    connections,
    transactions: [],
    respond,
    request() {
      // pool.request() takes an ARBITRARY connection — round-robining here
      // proves runReadOnlyBatch cannot rely on pool-request affinity.
      const conn = connections[next % connections.length];
      next += 1;
      return {
        async query(sql) {
          const text = String(sql);
          calls.push(text);
          conn.calls.push(text);
          return respond(text);
        },
      };
    },
  };
  return pool;
}

/**
 * Minimal tedious-shaped driver for mssqlBridge.runReadOnlyBatch: new
 * Transaction(pool).begin() acquires and holds ONE underlying connection;
 * new Request(tx) executes on exactly that connection (BEGIN/ROLLBACK log
 * onto it the way the real driver's begin/rollback wire messages do).
 */
function makeFakeMssqlTxDriver() {
  class Transaction {
    constructor(pool) { this.pool = pool; this.conn = null; pool.transactions.push(this); }
    async begin() {
      const free = this.pool.connections.find((c) => c.leasedBy === null);
      if (!free) throw new Error("pool exhausted: no free connection");
      free.leasedBy = this;
      this.conn = free;
      this.pool.calls.push("BEGIN TRANSACTION");
      this.conn.calls.push("BEGIN TRANSACTION");
    }
    async rollback() { this.release("ROLLBACK"); }
    async commit() { this.release("COMMIT"); }
    release(marker) {
      if (!this.conn) return;
      this.pool.calls.push(marker);
      this.conn.calls.push(marker);
      this.conn.leasedBy = null;
      this.conn = null;
    }
  }
  class Request {
    constructor(tx, _overrides) { this.tx = tx; }
    async query(sql) {
      const text = String(sql);
      if (!this.tx.conn) throw new Error("transaction has no leased connection");
      this.tx.pool.calls.push(text);
      this.tx.conn.calls.push(text);
      return this.tx.pool.respond(text);
    }
  }
  return { Transaction, Request };
}

/** Real node:sqlite DatabaseSync over a temp file, registered in the registry. */
function registerSqliteConnection(registry, { withView = false } = {}) {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { DatabaseSync } = require("node:sqlite");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qd-dbsvc-sqlite-"));
  const filePath = path.join(dir, "notes.db");
  const db = new DatabaseSync(filePath);
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL)");
  db.exec("INSERT INTO notes (title) VALUES ('seed')");
  if (withView) db.exec("CREATE VIEW v_notes AS SELECT id FROM notes");
  const cleanup = () => {
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  const connectionId = registry.registerConnection({
    dialect: "sqlite", senderId: 1, client: { db, filePath, readOnly: false }, close: cleanup,
    meta: { hostname: filePath, port: null, database: "notes.db", username: null },
  });
  return { connectionId, db, cleanup };
}

// ---- new-dialect routing ----

test("mariadb schema/query/execute route through the mysql-family path", async () => {
  const { service, registry } = setup();
  const conn = makeFakeMysqlConn((sql) => {
    if (/information_schema\.tables/i.test(sql)) return { fields: [{ name: "schema" }, { name: "name" }, { name: "kind" }], rows: [{ schema: "shop", name: "users", kind: "BASE TABLE" }] };
    if (/information_schema\.columns/i.test(sql)) return { fields: [{ name: "column_name" }], rows: [{ column_name: "id", data_type: "int", is_nullable: "NO", column_default: null, column_key: "PRI" }] };
    if (/^SELECT/i.test(sql)) return { fields: [{ name: "id" }], rows: [{ id: 1 }] };
    return { fields: null, rows: [], okPacket: { affectedRows: 2 } };
  });
  const mariaId = registry.registerConnection({
    dialect: "mariadb", senderId: 1, client: { conn }, close() {},
    meta: { hostname: "maria.local", port: 3306, database: "shop", username: "app" },
  });

  const tables = await service.schema({ connectionId: mariaId });
  assert.equal(tables.ok, true);
  assert.match(conn.calls[0], /information_schema\.tables/); // same family metadata SQL, no duplicate branch
  assert.deepEqual(tables.tables, [{ schema: "shop", name: "users", kind: "BASE TABLE" }]);

  const columns = await service.schema({ connectionId: mariaId, table: "users" });
  assert.equal(columns.ok, true);
  assert.deepEqual(columns.primaryKey, ["id"]);

  const query = await service.query({ connectionId: mariaId, sql: "SELECT id FROM t" });
  assert.equal(query.ok, true);
  assert.equal(query.dialect, "mariadb");
  assert.equal(query.readOnly, true);
  // mysql-family READ ONLY transaction wrapper (readOnlyTransaction("mariadb"))
  assert.deepEqual(conn.calls.slice(2), ["START TRANSACTION READ ONLY", "SELECT id FROM t", "ROLLBACK"]);

  const exec = await service.execute({ connectionId: mariaId, sql: "UPDATE t SET a=1" });
  assert.equal(exec.ok, true);
  assert.equal(exec.dialect, "mariadb"); // no hardcoded "mysql" label
  assert.equal(exec.resultSets[0].affectedRows, 2);
});

test("sqlite query gate: SELECT passes under BEGIN/ROLLBACK, INSERT rejected, execute INSERT persists", async () => {
  const { service, registry } = setup();
  const { connectionId, db, cleanup } = registerSqliteConnection(registry);
  try {
    const denied = await service.query({ connectionId, sql: "INSERT INTO notes (title) VALUES ('x')" });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, "READ_ONLY_VIOLATION");
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM notes").get().c, 1); // gate fired before any exec

    const sel = await service.query({ connectionId, sql: "SELECT id, title FROM notes ORDER BY id" });
    assert.equal(sel.ok, true);
    assert.equal(sel.dialect, "sqlite");
    assert.equal(sel.readOnly, true);
    assert.deepEqual(sel.resultSets[0].rows, [{ id: "1", title: "seed" }]);
    assert.equal(sel.resultSets[0].truncated, false);

    const ins = await service.execute({ connectionId, sql: "INSERT INTO notes (title) VALUES ('written-by-ai')" });
    assert.equal(ins.ok, true);
    assert.equal(ins.dialect, "sqlite");
    assert.equal(ins.resultSets[0].affectedRows, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM notes WHERE title = 'written-by-ai'").get().c, 1);
  } finally {
    cleanup();
  }
});

test("sqlite schema: sqlite_master listing + pragma table_info columns/pk", async () => {
  const { service, registry } = setup();
  const { connectionId, cleanup } = registerSqliteConnection(registry, { withView: true });
  try {
    const tables = await service.schema({ connectionId });
    assert.equal(tables.ok, true);
    assert.deepEqual(tables.tables, [
      { schema: "notes.db", name: "notes", kind: "BASE TABLE" },
      { schema: "notes.db", name: "v_notes", kind: "VIEW" },
    ]);
    const columns = await service.schema({ connectionId, table: "notes" });
    assert.equal(columns.ok, true);
    assert.equal(columns.table, "notes");
    assert.deepEqual(columns.columns.map((c) => c.column_name), ["id", "title"]);
    assert.equal(columns.columns[0].data_type, "INTEGER");
    assert.equal(columns.columns[1].is_nullable, "NO"); // title TEXT NOT NULL
    assert.deepEqual(columns.primaryKey, ["id"]);
  } finally {
    cleanup();
  }
});

test("mssql schema calls runLimitedQuery metadata and maps rows", async () => {
  const { service, registry } = setup();
  const pool = makeFakeMssqlPool();
  const mssqlId = registry.registerConnection({
    dialect: "mssql", senderId: 1, client: { pool }, close() {},
    meta: { hostname: "sql.local", port: 1433, database: "app", username: "sa" },
  });
  const tables = await service.schema({ connectionId: mssqlId });
  assert.equal(tables.ok, true);
  assert.match(pool.calls[0], /INFORMATION_SCHEMA\.TABLES/);
  assert.deepEqual(tables.tables, [{ schema: "dbo", name: "users", kind: "BASE TABLE" }]);

  const columns = await service.schema({ connectionId: mssqlId, table: "users" });
  assert.equal(columns.ok, true);
  assert.deepEqual(columns.columns[0], { COLUMN_NAME: "id", DATA_TYPE: "int", IS_NULLABLE: "NO", COLUMN_DEFAULT: null });
  assert.deepEqual(columns.primaryKey, ["id"]);
  assert.match(pool.calls.at(-1), /TABLE_CONSTRAINTS/);
});

test("mssql query binds BEGIN/query/ROLLBACK to ONE connection and rejects writes", async () => {
  const { service, registry } = setup();
  const mssqlBridge = require("../../bridges/mssqlBridge.cjs");
  const pool = makeFakeMssqlPool();
  const mssqlId = registry.registerConnection({
    dialect: "mssql", senderId: 1, client: { pool }, close() {},
    meta: { hostname: "sql.local", port: 1433, database: "app", username: "sa" },
  });
  const denied = await service.query({ connectionId: mssqlId, sql: "UPDATE users SET name='b'" });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "READ_ONLY_VIOLATION");
  assert.deepEqual(pool.calls, []); // keyword gate fires before any pool request

  mssqlBridge._setDriverForTests(makeFakeMssqlTxDriver());
  try {
    const res = await service.query({ connectionId: mssqlId, sql: "SELECT id FROM users" });
    assert.equal(res.ok, true);
    assert.equal(res.dialect, "mssql");
    assert.equal(res.readOnly, true);
    assert.equal(pool.calls[0], "BEGIN TRANSACTION");
    assert.equal(pool.calls.at(-1), "ROLLBACK");
    assert.deepEqual(res.resultSets[0].columns, [{ name: "id" }, { name: "name" }]);
    assert.deepEqual(res.resultSets[0].rows, [{ id: "1", name: "a" }]);

    // The pool round-robins pool.request() over 3 underlying connections, so
    // the whole read-only batch (BEGIN → SELECT → ROLLBACK) landing on exactly
    // ONE of them proves the Transaction pinned a single connection — a
    // scattered batch would run outside the transaction (SELECT ... INTO
    // would persist) and leave the ROLLBACK leaking on another connection.
    const touched = pool.connections.filter((c) => c.calls.length > 0);
    assert.equal(touched.length, 1);
    assert.deepEqual(touched[0].calls, ["BEGIN TRANSACTION", "SELECT id FROM users", "ROLLBACK"]);

    // The read path never commits and releases its leased connection (no
    // leaked transaction blocking applyTableChanges).
    assert.ok(!pool.calls.includes("COMMIT"));
    assert.equal(pool.transactions.length, 1);
    assert.ok(pool.connections.every((c) => c.leasedBy === null));
  } finally {
    mssqlBridge._setDriverForTests(undefined);
  }
});

test("mssql execute returns the rowsAffected aggregate", async () => {
  const { service, registry } = setup();
  const pool = makeFakeMssqlPool();
  const mssqlId = registry.registerConnection({
    dialect: "mssql", senderId: 1, client: { pool }, close() {},
    meta: { hostname: "sql.local", port: 1433, database: "app", username: "sa" },
  });
  const res = await service.execute({ connectionId: mssqlId, sql: "UPDATE users SET name='b'" });
  assert.equal(res.ok, true);
  assert.equal(res.dialect, "mssql");
  assert.deepEqual(pool.calls, ["UPDATE users SET name='b'"]);
  assert.equal(res.resultSets[0].affectedRows, 3);
});

test("database/connections/list exposes mariadb/mssql/sqlite dialects", async () => {
  const { service, registry } = setup();
  const pool = makeFakeMssqlPool();
  registry.registerConnection({
    dialect: "mariadb", senderId: 1, client: { conn: makeFakeMysqlConn(() => ({ rows: [] })) }, close() {},
    meta: { hostname: "maria.local", port: 3306, database: "shop", username: null },
  });
  registry.registerConnection({
    dialect: "mssql", senderId: 1, client: { pool }, close() {},
    meta: { hostname: "sql.local", port: 1433, database: "app", username: "sa" },
  });
  registry.registerConnection({
    dialect: "sqlite", senderId: 1, client: {}, close() {},
    meta: { hostname: "/tmp/notes.db", port: null, database: "notes.db", username: null },
  });
  const all = await service.listConnections({});
  const dialects = all.connections.map((c) => c.dialect);
  for (const d of ["mysql", "postgresql", "redis", "mariadb", "mssql", "sqlite"]) {
    assert.ok(dialects.includes(d), `missing ${d}`);
  }
  const mariadbOnly = await service.listConnections({ dialect: "mariadb" });
  assert.equal(mariadbOnly.connections.length, 1);
  assert.equal(mariadbOnly.connections[0].database, "shop");
});

test("redis_key_edit maps actions to commands and validates params", async () => {
  const { service, ids, redisDial } = setup();
  const expire = await service.redisEditKey({ connectionId: ids.redisId, action: "expire", key: "k", ttlSeconds: 60 });
  assert.equal(expire.ok, true);
  assert.deepEqual(redisDial.client.commands.at(-1), ["EXPIRE", "k", "60"]);
  const persist = await service.redisEditKey({ connectionId: ids.redisId, action: "expire", key: "k", ttlSeconds: 0 });
  assert.deepEqual(redisDial.client.commands.at(-1), ["PERSIST", "k"]);
  const set = await service.redisEditKey({ connectionId: ids.redisId, action: "stringSet", key: "k", value: "v", ttlSeconds: 30 });
  assert.deepEqual(redisDial.client.commands.at(-1), ["SET", "k", "v", "EX", "30"]);
  const zadd = await service.redisEditKey({ connectionId: ids.redisId, action: "zadd", key: "k", value: "m", score: 1.5 });
  assert.deepEqual(redisDial.client.commands.at(-1), ["ZADD", "k", "1.5", "m"]);
  const noScore = await service.redisEditKey({ connectionId: ids.redisId, action: "zadd", key: "k", value: "m" });
  assert.equal(noScore.code, "INVALID_PARAMS");
  const noValue = await service.redisEditKey({ connectionId: ids.redisId, action: "stringSet", key: "k" });
  assert.equal(noValue.code, "INVALID_PARAMS");
  const badAction = await service.redisEditKey({ connectionId: ids.redisId, action: "flushall", key: "k" });
  assert.equal(badAction.code, "INVALID_PARAMS");
});
