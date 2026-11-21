const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const registry = require("./dbCommon/connectionRegistry.cjs");

const { EventEmitter } = require("events");

function makeFakeMysql() {
  const connections = [];
  const queries = [];
  return {
    connections,
    queries,
    createConnection: (opts) => {
      const conn = {
        opts,
        connect: (cb) => cb(null),
        on: () => {},
        end: (cb) => { connections.push("ended"); if (cb) cb(); },
        destroy: () => { connections.push("destroyed"); },
        // mysql2 stream-mode shape: query() returns an EventEmitter that
        // emits fields -> result* -> end (or error). The bridge subscribes.
        query: (sqlOrObj) => {
          queries.push(sqlOrObj);
          const sql = typeof sqlOrObj === "string" ? sqlOrObj : sqlOrObj.sql;
          const emitter = new EventEmitter();
          const lower = String(sql).toLowerCase();
          const emitRows = (fields, rows) => {
            setImmediate(() => {
              if (fields) emitter.emit("fields", fields);
              for (const row of rows) emitter.emit("result", row);
              emitter.emit("end");
            });
          };
          if (lower.includes(";") && lower.includes("update")) {
            // SELECT followed by an OK packet: exercises per-segment okPacket capture.
            setImmediate(() => {
              emitter.emit("fields", [{ name: "id" }]);
              emitter.emit("result", { id: 1 });
              emitter.emit("fields", void 0);
              emitter.emit("result", { affectedRows: 5 });
              emitter.emit("end");
            });
          } else if (lower.includes(";")) {
            // Multi-statement: two result sets in one query.
            setImmediate(() => {
              emitter.emit("fields", [{ name: "id" }]);
              emitter.emit("result", { id: 1 });
              emitter.emit("fields", [{ name: "n" }]);
              emitter.emit("result", { n: "x" });
              emitter.emit("end");
            });
          } else if (lower.startsWith("select s.schema_name")) {
            // schemaTree: SCHEMATA LEFT JOIN TABLES — one row per table plus a
            // null-table row for the empty schema (single round trip).
            emitRows(null, [
              { name: "app", table_name: "users", kind: "BASE" },
              { name: "app", table_name: "orders_view", kind: "VIEW" },
              { name: "sys", table_name: null, kind: null },
            ]);
          } else if (lower.includes("database()")) {
            emitRows(null, [{ db: "app" }]);
          } else if (lower.startsWith("show tables") || lower.startsWith("select table_name")) {
            emitRows(null, [{ name: "users", kind: "base" }, { name: "orders_view", kind: "view" }]);
          } else if (lower.startsWith("show full tables")) {
            emitRows(null, [{ Tables_in_app: "orders_view", Table_type: "VIEW" }]);
          } else if (lower.startsWith("show create view")) {
            emitRows(null, [{ View: "orders_view", "Create View": "CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` VIEW `orders_view` AS SELECT * FROM `users`" }]);
          } else if (lower.startsWith("show columns") || lower.startsWith("select column_name")) {
            emitRows(null, [
              { Field: "id", Type: "int", Null: "NO", Key: "PRI", Default: null },
              { Field: "name", Type: "varchar(80)", Null: "YES", Key: "", Default: null },
            ]);
          } else if (lower.startsWith("show create table")) {
            // DDL carries two FOREIGN KEY clauses: a plain ref (refSchema must
            // stay undefined) and a schema-qualified ref (refSchema captured).
            emitRows(null, [{ Table: "users", "Create Table": [
              "CREATE TABLE `users` (",
              "  `id` int NOT NULL,",
              "  `parent_id` int DEFAULT NULL,",
              "  `org_id` int DEFAULT NULL,",
              "  PRIMARY KEY (`id`),",
              "  KEY `org_id` (`org_id`),",
              "  CONSTRAINT `users_ibfk_1` FOREIGN KEY (`parent_id`) REFERENCES `user_groups` (`id`),",
              "  CONSTRAINT `users_ibfk_2` FOREIGN KEY (`org_id`) REFERENCES `other_db`.`orgs` (`oid`)",
              ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            ].join("\n") }]);
          } else if (lower.startsWith("show index") || lower.startsWith("select index_name")) {
            emitRows(null, [{ Key_name: "PRIMARY", Column_name: "id", Non_unique: 0, Index_type: "BTREE" }]);
          } else if (lower.includes("table_rows")) {
            emitRows(null, [{ c: 42 }]);
          } else if (lower.includes("version()")) {
            emitRows([{ name: "v" }], [{ v: "8.0.36" }]);
          } else if (lower.startsWith("select") || lower.startsWith("with")) {
            emitRows([{ name: "id" }, { name: "name" }], [{ id: 1, name: "a" }, { id: 2, name: "b" }]);
          } else {
            setImmediate(() => emitter.emit("result", { affectedRows: 1 }));
            setImmediate(() => emitter.emit("end"));
          }
          return emitter;
        },
      };
      return conn;
    },
  };
}

function setup() {
  registry._resetForTests();
  const bridge = require("./mysqlBridge.cjs");
  const fake = makeFakeMysql();
  bridge._setDriverForTests(fake);
  const handlers = new Map();
  bridge.registerHandlers({ handle: (c, fn) => handlers.set(c, fn) }, {});
  const pushes = [];
  const event = { sender: { id: 21, isDestroyed: () => false, send: (_channel, payload) => pushes.push(payload), once() {}, removeListener() {} } };
  return { bridge, fake, pushes, call: async (channel, payload) => handlers.get(channel)(event, payload) };
}

/** Poll the captured job-progress pushes until one with `phase` lands
 *  (optionally only at or after index `since` — the array is live). */
function waitForPush(pushes, phase, timeoutMs = 3000, since = 0) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const hit = pushes.find((p, i) => i >= since && p.phase === phase);
      if (hit) return resolve(hit);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`timeout waiting for phase '${phase}'; pushes=${JSON.stringify(pushes)}`));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function tmpSqlFile(label) {
  return path.join(os.tmpdir(), `nc-mysql-bridge-test-${label}-${process.pid}-${Math.random().toString(16).slice(2)}.sql`);
}

test("connect, schemaTree, tableMeta, tableRows, query", async () => {
  const { bridge, fake, call } = setup();
  const conn = await call("quolldesk:mysql:connect", { hostname: "db", port: 3306, username: "root", password: "pw", config: { database: "app" } });
  assert.equal(conn.ok, true, JSON.stringify(conn));
  assert.equal(conn.data.connectionId.length > 0, true);
  const { connectionId } = conn.data;
  const opened = fake.connections.length; // sanity: driver created

  const tree = await call("quolldesk:mysql:schemaTree", { connectionId });
  assert.equal(tree.ok, true);
  // One grouped query buckets tables/views per schema; empty schemas stay.
  assert.deepEqual(tree.data.databases, [
    { name: "app", tables: ["users"], views: ["orders_view"] },
    { name: "sys", tables: [], views: [] },
  ]);

  const meta = await call("quolldesk:mysql:tableMeta", { connectionId, table: "users" });
  assert.equal(meta.ok, true);
  assert.equal(meta.data.columns[0].name, "id");
  assert.equal(meta.data.indexes[0].name, "PRIMARY");
  assert.equal(meta.data.indexes[0].method, "BTREE");
  assert.equal(meta.data.rowCountEstimate, 42);
  assert.ok(meta.data.ddl.includes("CREATE TABLE"));
  assert.deepEqual(meta.data.foreignKeys, [
    { column: "parent_id", refTable: "user_groups", refColumn: "id" },
    { column: "org_id", refTable: "orgs", refSchema: "other_db", refColumn: "oid" },
  ]);

  const rows = await call("quolldesk:mysql:tableRows", { connectionId, table: "users", offset: 0, limit: 100 });
  assert.equal(rows.ok, true);
  assert.deepEqual(rows.data.columns, [{ name: "id" }, { name: "name" }]);
  assert.equal(rows.data.rows.length, 2);
  assert.equal(rows.data.truncated, false);

  const q = await call("quolldesk:mysql:query", { connectionId, sql: "SELECT * FROM users" });
  assert.equal(q.ok, true);
  assert.equal(q.data.resultSets[0].columns[0].name, "id");
  assert.equal(q.data.resultSets[0].rows.length, 2);

  const update = await call("quolldesk:mysql:query", { connectionId, sql: "UPDATE t SET x=1" });
  assert.equal(update.data.resultSets[0].affectedRows, 1);

  const multi = await call("quolldesk:mysql:query", { connectionId, sql: "SELECT 1; SELECT 2" });
  assert.equal(multi.ok, true, JSON.stringify(multi));
  assert.equal(multi.data.resultSets.length, 2);
  assert.deepEqual(multi.data.resultSets[0].columns, [{ name: "id" }]);
  assert.deepEqual(multi.data.resultSets[0].rows, [["1"]]);
  assert.deepEqual(multi.data.resultSets[1].columns, [{ name: "n" }]);
  assert.deepEqual(multi.data.resultSets[1].rows, [["x"]]);

  const mixed = await call("quolldesk:mysql:query", { connectionId, sql: "SELECT 1; UPDATE t SET x=1" });
  assert.equal(mixed.ok, true, JSON.stringify(mixed));
  assert.deepEqual(mixed.data.resultSets[0].rows, [["1"]]);
  assert.equal(mixed.data.resultSets[1].affectedRows, 5);

  const notConn = await call("quolldesk:mysql:schemaTree", { connectionId: "zzz" });
  assert.equal(notConn.error.code, "NOT_CONNECTED");

  await call("quolldesk:mysql:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("applyTableChanges runs a transaction and returns counts", async () => {
  const { bridge, call } = setup();
  const conn = await call("quolldesk:mysql:connect", { hostname: "db", port: 3306, username: "root", password: "pw" });
  const { connectionId } = conn.data;
  const res = await call("quolldesk:mysql:applyTableChanges", {
    connectionId,
    table: "users",
    changes: {
      updates: [{ pk: "id", pkValue: "1", column: "name", value: "renamed" }],
      inserts: [{ values: { id: "99", name: "new" } }],
      deletes: [{ pk: "id", pkValue: "2" }],
    },
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.data.applied, { updates: 1, inserts: 1, deletes: 1 });
  const empty = await call("quolldesk:mysql:applyTableChanges", { connectionId, table: "users", changes: {} });
  assert.deepEqual(empty.data.applied, { updates: 0, inserts: 0, deletes: 0 });
  await call("quolldesk:mysql:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("query error surfaces envelope with QUERY_ERROR", async () => {
  const { bridge, call } = setup();
  const conn = await call("quolldesk:mysql:connect", { hostname: "db", port: 3306, username: "root", password: "pw" });
  const { connectionId } = conn.data;
  // monkey-patch this connection's query to fail (same EventEmitter shape)
  const entry = registry.getConnection(connectionId);
  entry.client.conn.query = (sqlOrObj) => {
    const emitter = new EventEmitter();
    setImmediate(() => emitter.emit("error", new Error("You have an error in your SQL syntax")));
    return emitter;
  };
  const q = await call("quolldesk:mysql:query", { connectionId, sql: "SELEC 1" });
  assert.equal(q.ok, false);
  assert.equal(q.error.code, "QUERY_ERROR");
  bridge._setDriverForTests(undefined);
});

test("tableRows orderDir and filters compile to quoted WHERE + ? placeholders", async () => {
  const { bridge, fake, call } = setup();
  const conn = await call("quolldesk:mysql:connect", { hostname: "db", port: 3306, username: "root", password: "pw" });
  const { connectionId } = conn.data;
  const res = await call("quolldesk:mysql:tableRows", {
    connectionId,
    table: "users",
    orderBy: "id",
    orderDir: "desc",
    filters: [
      { column: "name", op: "like", value: "a" },
      { column: "id", op: "nul" },
      { column: "evil", op: "DROP TABLE users", value: "x" }, // invalid op must be ignored
    ],
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const last = fake.queries[fake.queries.length - 1];
  assert.ok(last.sql.includes("WHERE `name` LIKE ? AND `id` IS NULL"), last.sql);
  assert.ok(last.sql.includes("ORDER BY `id` DESC"), last.sql);
  assert.ok(!last.sql.toUpperCase().includes("DROP"));
  assert.deepEqual(last.values, ["%a%"]);

  // No filters / no dir: no WHERE, plain ORDER BY, values untouched.
  await call("quolldesk:mysql:tableRows", { connectionId, table: "users", orderBy: "id" });
  const plain = fake.queries[fake.queries.length - 1];
  assert.ok(!plain.sql.includes("WHERE"));
  assert.equal(plain.values, undefined);

  // Cap: more than 10 filters are truncated to 10 (9 value placeholders + IS NULL).
  const many = Array.from({ length: 13 }, (_, i) => ({ column: `c${i}`, op: "eq", value: String(i) }));
  await call("quolldesk:mysql:tableRows", { connectionId, table: "users", filters: many });
  const capped = fake.queries[fake.queries.length - 1];
  assert.equal((capped.sql.match(/AND/g) || []).length, 9, capped.sql);
  assert.equal(capped.values.length, 10);

  await call("quolldesk:mysql:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("backup streams a table dump and pushes progress; guard blocks concurrent jobs", async () => {
  const { bridge, pushes, call } = setup();
  const conn = await call("quolldesk:mysql:connect", { hostname: "db", port: 3306, username: "root", password: "pw", config: { database: "app" } });
  const { connectionId } = conn.data;
  const outFile = tmpSqlFile("backup");
  try {
    // Fire two backups without awaiting the first: the guard is registered
    // synchronously in the handler, so the second request must be rejected.
    const first = call("quolldesk:mysql:backup", { connectionId, scope: "table", table: "users", includeData: true, outFile });
    const second = call("quolldesk:mysql:backup", { connectionId, scope: "table", table: "users", includeData: true, outFile });
    const res = await first;
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(res.data.jobId.length > 0);
    const rejected = await second;
    assert.equal(rejected.ok, false);
    assert.match(rejected.error.message, /backup already in progress/);

    const done = await waitForPush(pushes, "done");
    assert.equal(done.dialect, "mysql");
    assert.match(done.message, /dumped 1 table/);

    const dump = fs.readFileSync(outFile, "utf8");
    assert.ok(dump.includes("-- Dialect: mysql"), dump.slice(0, 400));
    assert.ok(dump.includes("SET FOREIGN_KEY_CHECKS=0;"), dump.slice(0, 400));
    assert.ok(dump.includes("DROP TABLE IF EXISTS `users`;"));
    assert.ok(dump.includes("CREATE TABLE `users` ("));
    assert.ok(dump.includes("INSERT INTO `app`.`users` (`id`, `name`) VALUES"), dump);
    assert.ok(dump.includes("(1, 'a'),\n  (2, 'b');"), dump);
    assert.ok(dump.trimEnd().endsWith("SET FOREIGN_KEY_CHECKS=1;"));

    const tables = pushes.find((p) => p.phase === "tables");
    assert.equal(tables.table, "users");
    assert.equal(tables.tablesTotal, 1);
    const rows = pushes.find((p) => p.phase === "rows");
    assert.equal(rows.rowsDone, 2);
    // Guard cleared after completion: a follow-up job starts fine.
    const beforeAgain = pushes.length;
    const again = await call("quolldesk:mysql:backup", { connectionId, scope: "table", table: "users", includeData: false, outFile });
    assert.equal(again.ok, true, JSON.stringify(again));
    await waitForPush(pushes, "done", 3000, beforeAgain);
    const noDataDump = fs.readFileSync(outFile, "utf8");
    assert.ok(noDataDump.includes("CREATE TABLE `users` ("));
    assert.ok(!noDataDump.includes("INSERT INTO"), "includeData=false must not emit INSERTs");
  } finally {
    await call("quolldesk:mysql:disconnect", { connectionId });
    bridge._setDriverForTests(undefined);
    fs.unlink(outFile, () => {});
  }
});

test("database-scope dump appends views after tables; missing table cleans up", async () => {
  const { bridge, pushes, call } = setup();
  const conn = await call("quolldesk:mysql:connect", { hostname: "db", port: 3306, username: "root", password: "pw", config: { database: "app" } });
  const { connectionId } = conn.data;
  const outFile = tmpSqlFile("dump-all");
  try {
    const res = await call("quolldesk:mysql:backup", { connectionId, scope: "database", includeData: true, outFile });
    assert.equal(res.ok, true, JSON.stringify(res));
    await waitForPush(pushes, "done");
    const dump = fs.readFileSync(outFile, "utf8");
    // Views come after the table body.
    assert.ok(dump.indexOf("CREATE TABLE `users` (") < dump.indexOf("DROP VIEW IF EXISTS `orders_view`;"));
    assert.ok(dump.includes("CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` VIEW `orders_view` AS SELECT * FROM `users`;"));
  } finally {
    fs.unlink(outFile, () => {});
  }

  // Error mid-dump: phase 'error' push + partial file deleted, invoke still ok.
  const badFile = tmpSqlFile("missing");
  const errRes = await call("quolldesk:mysql:backup", { connectionId, scope: "table", table: "does_not_exist", outFile: badFile });
  assert.equal(errRes.ok, true);
  await waitForPush(pushes, "error");
  assert.ok(pushes.some((p) => p.phase === "error" && /table not found/.test(p.error)));
  await new Promise((r) => setTimeout(r, 30)); // unlink is best-effort async
  assert.equal(fs.existsSync(badFile), false, "partial dump file must be deleted on error");

  await call("quolldesk:mysql:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("restore splits statements sequentially and reports progress/done", async () => {
  const { bridge, pushes, call } = setup();
  const conn = await call("quolldesk:mysql:connect", { hostname: "db", port: 3306, username: "root", password: "pw", config: { database: "app" } });
  const { connectionId } = conn.data;
  const entry = registry.getConnection(connectionId);
  const executed = [];
  entry.client.conn.query = (sqlOrObj) => {
    executed.push(typeof sqlOrObj === "string" ? sqlOrObj : sqlOrObj.sql);
    const emitter = new EventEmitter();
    setImmediate(() => {
      emitter.emit("result", { affectedRows: 1 });
      emitter.emit("end");
    });
    return emitter;
  };
  const inFile = tmpSqlFile("restore");
  const script = [
    "-- QuollDesk dump header",
    "DROP TABLE IF EXISTS `t`;",
    "INSERT INTO `t` VALUES ('a;b');", // `;` inside the string must not split
    "INSERT INTO `t` VALUES ('it''s');",
  ].join("\n");
  try {
    fs.writeFileSync(inFile, script, "utf8");
    const res = await call("quolldesk:mysql:restore", { connectionId, inFile });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(res.data.jobId.length > 0);
    const done = await waitForPush(pushes, "done");
    assert.match(done.message, /3 statements executed/);
    assert.deepEqual(executed, [
      "DROP TABLE IF EXISTS `t`",
      "INSERT INTO `t` VALUES ('a;b')",
      "INSERT INTO `t` VALUES ('it''s')",
    ]);
    const progress = pushes.find((p) => p.phase === "restore");
    assert.equal(progress.total, 3);
  } finally {
    fs.unlink(inFile, () => {});
  }

  // Error path: failing statement reports its index and stops the run.
  const badEntry = registry.getConnection(connectionId);
  badEntry.client.conn.query = (sqlOrObj) => {
    const sql = typeof sqlOrObj === "string" ? sqlOrObj : sqlOrObj.sql;
    const emitter = new EventEmitter();
    setImmediate(() => {
      if (sql.includes("boom")) emitter.emit("error", new Error("boom at statement 2"));
      else emitter.emit("end");
    });
    return emitter;
  };
  const badFile = tmpSqlFile("restore-err");
  fs.writeFileSync(badFile, "SELECT 1;\nSELECT boom;\nSELECT 3;\n", "utf8");
  try {
    const res = await call("quolldesk:mysql:restore", { connectionId, inFile: badFile });
    assert.equal(res.ok, true);
    const error = await new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        const hit = pushes.find((p) => p.phase === "error");
        if (hit) return resolve(hit);
        if (Date.now() - started > 3000) return reject(new Error("no error push"));
        setTimeout(tick, 10);
      };
      tick();
    });
    assert.equal(error.index, 1);
    assert.match(error.error, /boom at statement 2/);
  } finally {
    fs.unlink(badFile, () => {});
  }

  await call("quolldesk:mysql:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("pickBackupPath / pickRestoreFile use the injected dialog", async () => {
  const { bridge, call } = setup();
  const seen = [];
  bridge._setDialogForTests({
    showSaveDialog: async (owner, opts) => { seen.push({ owner, opts }); return { canceled: false, filePath: "/tmp/out.sql" }; },
  });
  const picked = await call("quolldesk:mysql:pickBackupPath", { defaultName: "app_table_20260101.sql" });
  assert.deepEqual(picked, { ok: true, data: { path: "/tmp/out.sql" } });
  assert.equal(seen[0].opts.defaultPath, "app_table_20260101.sql");
  assert.deepEqual(seen[0].opts.filters, [{ name: "SQL", extensions: ["sql"] }]);

  bridge._setDialogForTests({ showSaveDialog: async () => ({ canceled: true }) });
  const cancelled = await call("quolldesk:mysql:pickBackupPath", {});
  assert.deepEqual(cancelled, { ok: true, data: { path: null } });

  bridge._setDialogForTests({ showOpenDialog: async () => ({ canceled: false, filePaths: ["/tmp/in.sql"] }) });
  const opened = await call("quolldesk:mysql:pickRestoreFile");
  assert.deepEqual(opened, { ok: true, data: { path: "/tmp/in.sql" } });

  bridge._setDialogForTests(undefined);
  bridge._setDriverForTests(undefined);
});
