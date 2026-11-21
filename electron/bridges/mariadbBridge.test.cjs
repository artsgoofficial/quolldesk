const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const registry = require("./dbCommon/connectionRegistry.cjs");

const { EventEmitter } = require("events");

// Same fake mysql2 driver as mysqlBridge.test.cjs — the MariaDB bridge speaks
// the mysql2 wire protocol (MariaDB compatibility), so the EventEmitter fake
// shape is identical; only the IPC channel prefix and dialect label differ.
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
            emitRows(null, [{ Table: "users", "Create Table": "CREATE TABLE `users` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4" }]);
          } else if (lower.startsWith("show index") || lower.startsWith("select index_name")) {
            emitRows(null, [{ Key_name: "PRIMARY", Column_name: "id", Non_unique: 0, Index_type: "BTREE" }]);
          } else if (lower.includes("table_rows")) {
            emitRows(null, [{ c: 42 }]);
          } else if (lower.includes("version()")) {
            emitRows([{ name: "v" }], [{ v: "10.11.6-MariaDB" }]);
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

const mariadbBridge = require("./mariadbBridge.cjs");
const mysqlBridge = require("./mysqlBridge.cjs");

function setup(bridge) {
  registry._resetForTests();
  const fake = makeFakeMysql();
  bridge._setDriverForTests(fake);
  const handlers = new Map();
  bridge.registerHandlers({ handle: (c, fn) => handlers.set(c, fn) }, {});
  const pushes = [];
  const event = { sender: { id: 21, isDestroyed: () => false, send: (_channel, payload) => pushes.push(payload), once() {}, removeListener() {} } };
  return { bridge, fake, pushes, call: async (channel, payload) => handlers.get(channel)(event, payload) };
}

// Pair setup: both family bridges share the process-wide registry, so one
// reset covers both and each keeps its own fake driver + handler map.
function setupPair() {
  registry._resetForTests();
  const makeSide = (bridge) => {
    const fake = makeFakeMysql();
    bridge._setDriverForTests(fake);
    const handlers = new Map();
    bridge.registerHandlers({ handle: (c, fn) => handlers.set(c, fn) }, {});
    const event = { sender: { id: 21, isDestroyed: () => false, send: () => {}, once() {}, removeListener() {} } };
    return { bridge, fake, call: async (channel, payload) => handlers.get(channel)(event, payload) };
  };
  return { mariadb: makeSide(mariadbBridge), mysql: makeSide(mysqlBridge) };
}

/** Poll the captured job-progress pushes until one with `phase` lands. */
function waitForPush(pushes, phase, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const hit = pushes.find((p) => p.phase === phase);
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
  return path.join(os.tmpdir(), `nc-mariadb-bridge-test-${label}-${process.pid}-${Math.random().toString(16).slice(2)}.sql`);
}

const CONNECT_OPTS = { hostname: "db", port: 3306, username: "root", password: "pw" };

test("connect registers with dialect 'mariadb'; schemaTree SQL is identical to the mysql bridge", async () => {
  const { mariadb, mysql } = setupPair();
  const conn = await mariadb.call("quolldesk:mariadb:connect", { ...CONNECT_OPTS, config: { database: "app" } });
  assert.equal(conn.ok, true, JSON.stringify(conn));
  const { connectionId } = conn.data;
  const entry = registry.getConnection(connectionId);
  assert.equal(entry.dialect, "mariadb");

  const queriesBefore = mariadb.fake.queries.length;
  const tree = await mariadb.call("quolldesk:mariadb:schemaTree", { connectionId });
  assert.equal(tree.ok, true, JSON.stringify(tree));
  assert.deepEqual(tree.data.databases, [
    { name: "app", tables: ["users"], views: ["orders_view"] },
    { name: "sys", tables: [], views: [] },
  ]);
  // Single round trip: exactly one query between connect and the tree result.
  assert.equal(mariadb.fake.queries.length - queriesBefore, 1);
  const mariadbSql = mariadb.fake.queries[queriesBefore].sql;

  // Same tree through the mysql bridge — the schemaTree SQL must be identical.
  const mysqlConn = await mysql.call("quolldesk:mysql:connect", { ...CONNECT_OPTS, config: { database: "app" } });
  assert.equal(mysqlConn.ok, true, JSON.stringify(mysqlConn));
  const mysqlBefore = mysql.fake.queries.length;
  const mysqlTree = await mysql.call("quolldesk:mysql:schemaTree", { connectionId: mysqlConn.data.connectionId });
  assert.equal(mysqlTree.ok, true);
  const mysqlSql = mysql.fake.queries[mysqlBefore].sql;
  assert.equal(mariadbSql, mysqlSql);
  assert.ok(mariadbSql.startsWith("SELECT s.SCHEMA_NAME AS name"), mariadbSql);

  await mariadb.call("quolldesk:mariadb:disconnect", { connectionId });
  await mysql.call("quolldesk:mysql:disconnect", { connectionId: mysqlConn.data.connectionId });
  mariadb.bridge._setDriverForTests(undefined);
  mysql.bridge._setDriverForTests(undefined);
});

test("test returns the serverVersion reported by the driver", async () => {
  const { bridge, call } = setup(mariadbBridge);
  const res = await call("quolldesk:mariadb:test", CONNECT_OPTS);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.serverVersion, "10.11.6-MariaDB");
  assert.equal(typeof res.data.latencyMs, "number");
  bridge._setDriverForTests(undefined);
});

test("query segments multi-statement results", async () => {
  const { bridge, call } = setup(mariadbBridge);
  const conn = await call("quolldesk:mariadb:connect", CONNECT_OPTS);
  const { connectionId } = conn.data;

  const multi = await call("quolldesk:mariadb:query", { connectionId, sql: "SELECT 1; SELECT 2" });
  assert.equal(multi.ok, true, JSON.stringify(multi));
  assert.equal(multi.data.resultSets.length, 2);
  assert.deepEqual(multi.data.resultSets[0].columns, [{ name: "id" }]);
  assert.deepEqual(multi.data.resultSets[0].rows, [["1"]]);
  assert.deepEqual(multi.data.resultSets[1].columns, [{ name: "n" }]);
  assert.deepEqual(multi.data.resultSets[1].rows, [["x"]]);

  const mixed = await call("quolldesk:mariadb:query", { connectionId, sql: "SELECT 1; UPDATE t SET x=1" });
  assert.equal(mixed.ok, true, JSON.stringify(mixed));
  assert.deepEqual(mixed.data.resultSets[0].rows, [["1"]]);
  assert.equal(mixed.data.resultSets[1].affectedRows, 5);

  await call("quolldesk:mariadb:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("backup progress and dump header carry the mariadb dialect", async () => {
  const { bridge, pushes, call } = setup(mariadbBridge);
  const conn = await call("quolldesk:mariadb:connect", { ...CONNECT_OPTS, config: { database: "app" } });
  const { connectionId } = conn.data;
  const outFile = tmpSqlFile("backup");
  try {
    const res = await call("quolldesk:mariadb:backup", { connectionId, scope: "table", table: "users", includeData: true, outFile });
    assert.equal(res.ok, true, JSON.stringify(res));
    const done = await waitForPush(pushes, "done");
    assert.equal(done.dialect, "mariadb");
    const dump = fs.readFileSync(outFile, "utf8");
    assert.ok(dump.includes("-- Dialect: mariadb"), dump.slice(0, 400));
    assert.ok(!dump.includes("-- Dialect: mysql"), dump.slice(0, 400));
    assert.ok(dump.includes("DROP TABLE IF EXISTS `users`;"), dump.slice(0, 400));
    assert.ok(dump.trimEnd().endsWith("SET FOREIGN_KEY_CHECKS=1;"));
  } finally {
    await call("quolldesk:mariadb:disconnect", { connectionId });
    bridge._setDriverForTests(undefined);
    fs.unlink(outFile, () => {});
  }
});

test("restore jobProgress carries the mariadb dialect and executes statements sequentially", async () => {
  const { bridge, pushes, call } = setup(mariadbBridge);
  const conn = await call("quolldesk:mariadb:connect", { ...CONNECT_OPTS, config: { database: "app" } });
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
  ].join("\n");
  try {
    fs.writeFileSync(inFile, script, "utf8");
    const res = await call("quolldesk:mariadb:restore", { connectionId, inFile });
    assert.equal(res.ok, true, JSON.stringify(res));
    const done = await waitForPush(pushes, "done");
    // The family's dialect parameter must reach runSequentialRestore's pushes.
    assert.equal(done.dialect, "mariadb");
    assert.match(done.message, /2 statements executed/);
    assert.deepEqual(executed, [
      "DROP TABLE IF EXISTS `t`",
      "INSERT INTO `t` VALUES ('a;b')",
    ]);
    const progress = pushes.find((p) => p.phase === "restore");
    assert.equal(progress.dialect, "mariadb");
    assert.equal(progress.total, 2);
  } finally {
    await call("quolldesk:mariadb:disconnect", { connectionId });
    bridge._setDriverForTests(undefined);
    fs.unlink(inFile, () => {});
  }
});
