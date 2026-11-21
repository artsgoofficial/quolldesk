const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const registry = require("./dbCommon/connectionRegistry.cjs");

// Real-Driver tests: node:sqlite ships with system node (v26) / Electron 42.
// No driver mock — every test below opens actual temp-file databases.

const SQLITE_CHANNELS = [
  "quolldesk:sqlite:connect",
  "quolldesk:sqlite:disconnect",
  "quolldesk:sqlite:test",
  "quolldesk:sqlite:schemaTree",
  "quolldesk:sqlite:tableMeta",
  "quolldesk:sqlite:tableRows",
  "quolldesk:sqlite:query",
  "quolldesk:sqlite:applyTableChanges",
  "quolldesk:sqlite:pickBackupPath",
  "quolldesk:sqlite:pickRestoreFile",
  "quolldesk:sqlite:backup",
  "quolldesk:sqlite:restore",
  "quolldesk:sqlite:pickDatabaseFile",
];

function setup(senderId) {
  registry._resetForTests();
  const bridge = require("./sqliteBridge.cjs");
  const handlers = new Map();
  bridge.registerHandlers({ handle: (c, fn) => handlers.set(c, fn) }, {});
  const pushes = [];
  const event = { sender: { id: senderId, isDestroyed: () => false, send: (_channel, payload) => pushes.push(payload), once() {}, removeListener() {} } };
  return { bridge, handlers, pushes, call: async (channel, payload) => handlers.get(channel)(event, payload) };
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

test("registers all 13 sqlite channels", () => {
  const { handlers } = setup(61);
  for (const channel of SQLITE_CHANNELS) {
    assert.ok(handlers.has(channel), `missing channel: ${channel}`);
  }
});

test("connect, test, DDL, tableMeta, tableRows, query, applyTableChanges", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nc-sqlite-bridge-a-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const { bridge, handlers, call } = setup(62);

  const dbFile = path.join(dir, "src.db");
  const conn = await call("quolldesk:sqlite:connect", { hostname: dbFile });
  assert.equal(conn.ok, true, JSON.stringify(conn));
  assert.ok(conn.data.connectionId.length > 0);
  assert.ok(fs.existsSync(dbFile), "writable connect must create the database file");
  const { connectionId } = conn.data;

  const ping = await call("quolldesk:sqlite:test", { hostname: dbFile });
  assert.equal(ping.ok, true, JSON.stringify(ping));
  assert.ok(/^\d+\.\d+\.\d+/.test(ping.data.serverVersion), `unexpected serverVersion: ${ping.data.serverVersion}`);
  assert.ok(typeof ping.data.latencyMs === "number");

  // DDL + index via the query channel (multi-statement script).
  const ddl = await call("quolldesk:sqlite:query", {
    connectionId,
    sql: "CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT NOT NULL); CREATE INDEX idx_t_name ON t(name);",
  });
  assert.equal(ddl.ok, true, JSON.stringify(ddl));
  assert.equal(ddl.data.resultSets.length, 2);
  assert.equal(ddl.data.resultSets[0].affectedRows, 0);

  const ins = await call("quolldesk:sqlite:query", {
    connectionId,
    sql: "INSERT INTO t(name) VALUES ('alpha'), ('beta'), ('gamma')",
  });
  assert.equal(ins.ok, true, JSON.stringify(ins));
  assert.equal(ins.data.resultSets[0].affectedRows, 3);

  // tableMeta: PRI flag, PK, index, DDL, row count. (Note: a bare
  // `INTEGER PRIMARY KEY` is a rowid alias — table_info reports notnull=0,
  // so nullable=false is only asserted on the explicit NOT NULL column.)
  const meta = await call("quolldesk:sqlite:tableMeta", { connectionId, table: "t" });
  assert.equal(meta.ok, true, JSON.stringify(meta));
  assert.deepEqual(meta.data.columns.map((c) => c.name), ["id", "name"]);
  assert.equal(meta.data.columns[0].key, "PRI");
  assert.equal(meta.data.columns[0].nullable, true);
  assert.equal(meta.data.columns[1].nullable, false);
  assert.equal(meta.data.columns[1].key, null);
  assert.deepEqual(meta.data.primaryKey, { name: "PRIMARY", columns: ["id"] });
  const idx = meta.data.indexes.find((i) => i.name === "idx_t_name");
  assert.ok(idx, `index missing: ${JSON.stringify(meta.data.indexes)}`);
  assert.equal(idx.unique, false);
  assert.deepEqual(idx.columns, ["name"]);
  assert.match(meta.data.ddl, /^CREATE TABLE t\(/);
  assert.equal(meta.data.rowCountEstimate, 3);
  assert.deepEqual(meta.data.foreignKeys, []);

  // tableRows: paging + LIKE filter.
  const page1 = await call("quolldesk:sqlite:tableRows", { connectionId, table: "t", orderBy: "id", orderDir: "asc", offset: 0, limit: 2 });
  assert.equal(page1.ok, true, JSON.stringify(page1));
  assert.deepEqual(page1.data.columns, [{ name: "id" }, { name: "name" }]);
  assert.equal(page1.data.rows.length, 2);
  assert.equal(page1.data.truncated, false);
  assert.equal(page1.data.rows[0][1], "alpha");

  const page2 = await call("quolldesk:sqlite:tableRows", { connectionId, table: "t", orderBy: "id", orderDir: "asc", offset: 1, limit: 2 });
  assert.equal(page2.data.rows.length, 2);
  assert.equal(page2.data.rows[0][1], "beta");

  const filtered = await call("quolldesk:sqlite:tableRows", { connectionId, table: "t", filters: [{ column: "name", op: "like", value: "alp" }] });
  assert.equal(filtered.ok, true, JSON.stringify(filtered));
  assert.equal(filtered.data.rows.length, 1);
  assert.equal(filtered.data.rows[0][1], "alpha");

  // query: multi-statement script → two result sets (SELECT and write mixed).
  const multi = await call("quolldesk:sqlite:query", {
    connectionId,
    sql: "SELECT COUNT(*) AS c FROM t; SELECT name FROM t WHERE id = 2",
  });
  assert.equal(multi.ok, true, JSON.stringify(multi));
  assert.equal(multi.data.resultSets.length, 2);
  assert.equal(multi.data.resultSets[0].rows[0][0], "3");
  assert.equal(multi.data.resultSets[1].rows[0][0], "beta");
  assert.ok(typeof multi.data.executionTimeMs === "number");

  // applyTableChanges: one update, one insert, one delete — single transaction.
  const applied = await call("quolldesk:sqlite:applyTableChanges", {
    connectionId,
    table: "t",
    changes: {
      updates: [{ pk: "id", pkValue: 1, column: "name", value: "ALPHA" }],
      inserts: [{ values: { id: 10, name: "delta" } }],
      deletes: [{ pk: "id", pkValue: 2 }],
    },
  });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.deepEqual(applied.data.applied, { updates: 1, inserts: 1, deletes: 1 });
  const afterApply = await call("quolldesk:sqlite:tableRows", { connectionId, table: "t", orderBy: "id", orderDir: "asc" });
  assert.deepEqual(afterApply.data.rows.map((r) => r[0]), ["1", "3", "10"]);
  assert.equal(afterApply.data.rows[0][1], "ALPHA");

  // Transaction rollback: a failing change set leaves the table untouched.
  const failed = await call("quolldesk:sqlite:applyTableChanges", {
    connectionId,
    table: "t",
    changes: {
      updates: [{ pk: "id", pkValue: 3, column: "name", value: "SHOULD_NOT_STICK" }],
      inserts: [{ values: { id: 1, name: "duplicate pk" } }],
    },
  });
  assert.equal(failed.ok, false, JSON.stringify(failed));
  const afterFail = await call("quolldesk:sqlite:tableRows", { connectionId, table: "t", orderBy: "id", orderDir: "asc" });
  assert.equal(afterFail.data.rows.find((r) => r[0] === "3")[1], "gamma", "rollback must restore the pre-transaction value");

  // schemaTree: one database entry (the file basename) with tables/views.
  await call("quolldesk:sqlite:query", { connectionId, sql: "CREATE TABLE v_base(x); CREATE VIEW v_t AS SELECT id FROM t" });
  const tree = await call("quolldesk:sqlite:schemaTree", { connectionId });
  assert.equal(tree.ok, true, JSON.stringify(tree));
  assert.equal(tree.data.databases.length, 1);
  assert.equal(tree.data.databases[0].name, "src.db");
  assert.deepEqual(tree.data.databases[0].tables, ["t", "v_base"]);
  assert.deepEqual(tree.data.databases[0].views, ["v_t"]);

  // runAll export (Task 10 databaseService contract) + openDatabase helper.
  const { runAll, openDatabase } = bridge;
  const opened = openDatabase({ hostname: dbFile });
  const batched = runAll(opened.db, "SELECT 40 + 2 AS answer");
  assert.equal(batched.length, 1);
  assert.equal(batched[0].rows[0][0], "42");
  opened.db.close();

  // disconnect closes the connection: further use reports NOT_CONNECTED.
  const disc = await call("quolldesk:sqlite:disconnect", { connectionId });
  assert.equal(disc.ok, true, JSON.stringify(disc));
  const dead = await call("quolldesk:sqlite:schemaTree", { connectionId });
  assert.equal(dead.ok, false);
  assert.equal(dead.error.code, "NOT_CONNECTED");
  assert.ok(handlers.has("quolldesk:sqlite:disconnect"));
});

test("backup + restore round trip on real files", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nc-sqlite-bridge-c-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const { pushes, call } = setup(64);

  const srcFile = path.join(dir, "dump-src.db");
  const conn = await call("quolldesk:sqlite:connect", { hostname: srcFile });
  assert.equal(conn.ok, true, JSON.stringify(conn));
  const connectionId = conn.data.connectionId;

  await call("quolldesk:sqlite:query", {
    connectionId,
    sql: "CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT); CREATE INDEX idx_t_name ON t(name);" +
      "INSERT INTO t(name) VALUES ('alpha'), ('beta');" +
      "CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID; INSERT INTO kv VALUES ('k1', 'v1');" +
      "CREATE VIEW v_t AS SELECT id FROM t",
  });

  const outFile = path.join(dir, "dump.sql");
  const job = await call("quolldesk:sqlite:backup", { connectionId, scope: "database", includeData: true, outFile });
  assert.equal(job.ok, true, JSON.stringify(job));
  await waitForPush(pushes, "done");
  assert.ok(fs.existsSync(outFile), "dump file must exist");

  const dump = fs.readFileSync(outFile, "utf8");
  assert.match(dump, /-- QuollDesk SQL dump/);
  assert.match(dump, /-- Dialect: sqlite/);
  assert.match(dump, /CREATE TABLE t\(/);
  assert.match(dump, /CREATE INDEX idx_t_name/);
  assert.match(dump, /INSERT INTO "t"/);
  assert.match(dump, /'alpha'/);
  assert.match(dump, /INSERT INTO "kv"/, "WITHOUT ROWID table must be dumped via the OFFSET fallback");
  assert.match(dump, /'k1'/);
  assert.match(dump, /CREATE VIEW v_t/);

  // Restore into a brand-new database file (parent dir does not exist yet).
  const dstFile = path.join(dir, "nested", "deep", "restored.db");
  const conn2 = await call("quolldesk:sqlite:connect", { hostname: dstFile });
  assert.equal(conn2.ok, true, JSON.stringify(conn2));
  assert.ok(fs.existsSync(dstFile), "writable connect must mkdir the missing parent dir");
  const connectionId2 = conn2.data.connectionId;

  pushes.length = 0;
  const restore = await call("quolldesk:sqlite:restore", { connectionId: connectionId2, inFile: outFile });
  assert.equal(restore.ok, true, JSON.stringify(restore));
  await waitForPush(pushes, "done");

  const rows = await call("quolldesk:sqlite:tableRows", { connectionId: connectionId2, table: "t", orderBy: "id", orderDir: "asc" });
  assert.equal(rows.ok, true, JSON.stringify(rows));
  assert.deepEqual(rows.data.rows.map((r) => r[1]), ["alpha", "beta"]);
  const kv = await call("quolldesk:sqlite:tableRows", { connectionId: connectionId2, table: "kv" });
  assert.deepEqual(kv.data.rows.map((r) => r[0]), ["k1"]);
  const meta = await call("quolldesk:sqlite:tableMeta", { connectionId: connectionId2, table: "t" });
  assert.deepEqual(meta.data.primaryKey.columns, ["id"]);
  const tree = await call("quolldesk:sqlite:schemaTree", { connectionId: connectionId2 });
  assert.deepEqual(tree.data.databases[0].views, ["v_t"]);

  // Restore errors surface as an error push (garbage SQL file).
  const badFile = path.join(dir, "bad.sql");
  fs.writeFileSync(badFile, "CREATE TABLE ok1(x); THIS IS NOT SQL;", "utf8");
  pushes.length = 0;
  const bad = await call("quolldesk:sqlite:restore", { connectionId: connectionId2, inFile: badFile });
  assert.equal(bad.ok, true, JSON.stringify(bad));
  const errPush = await waitForPush(pushes, "error");
  assert.match(errPush.error, /syntax error|near/i);
});

test("readOnly connect blocks writes with a driver-level error", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nc-sqlite-bridge-d-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const { call } = setup(65);

  const dbFile = path.join(dir, "ro.db");
  const writable = await call("quolldesk:sqlite:connect", { hostname: dbFile });
  assert.equal(writable.ok, true, JSON.stringify(writable));
  await call("quolldesk:sqlite:query", { connectionId: writable.data.connectionId, sql: "CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t VALUES (1, 'one')" });
  await call("quolldesk:sqlite:disconnect", { connectionId: writable.data.connectionId });

  const ro = await call("quolldesk:sqlite:connect", { hostname: dbFile, config: { readOnly: true } });
  assert.equal(ro.ok, true, JSON.stringify(ro));
  const roId = ro.data.connectionId;

  const write = await call("quolldesk:sqlite:query", { connectionId: roId, sql: "INSERT INTO t(name) VALUES ('nope')" });
  assert.equal(write.ok, false, "read-only connection must refuse writes");
  assert.match(write.error.message, /readonly/i);
  assert.equal(write.error.code, "PERMISSION_DENIED", JSON.stringify(write.error));

  const gridEdit = await call("quolldesk:sqlite:applyTableChanges", {
    connectionId: roId,
    table: "t",
    changes: { updates: [{ pk: "id", pkValue: 1, column: "name", value: "nope" }] },
  });
  assert.equal(gridEdit.ok, false);
  assert.match(gridEdit.error.message, /readonly/i);

  // Reads still work on the read-only connection.
  const read = await call("quolldesk:sqlite:tableRows", { connectionId: roId, table: "t" });
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(read.data.rows.length, 1);

  // Read-only open of a missing file fails cleanly (no file created).
  const missing = await call("quolldesk:sqlite:connect", { hostname: path.join(dir, "absent.db"), config: { readOnly: true } });
  assert.equal(missing.ok, false);
  assert.ok(!fs.existsSync(path.join(dir, "absent.db")));
});

test("connect validation: :memory: rejected, missing hostname rejected", async () => {
  const { call } = setup(66);
  const mem = await call("quolldesk:sqlite:connect", { hostname: ":memory:" });
  assert.equal(mem.ok, false);
  assert.match(mem.error.message, /memory/i);

  const empty = await call("quolldesk:sqlite:connect", {});
  assert.equal(empty.ok, false);
  const ping = await call("quolldesk:sqlite:test", {});
  assert.equal(ping.ok, false);
  const memTest = await call("quolldesk:sqlite:test", { hostname: ":memory:" });
  assert.equal(memTest.ok, false);
});

test("pickDatabaseFile + shared backup/restore dialogs use the injected dialog", async (t) => {
  const { bridge, call } = setup(67);
  const calls = [];
  const fakeDialog = {
    showOpenDialog: async (_owner, opts) => {
      calls.push(["open", opts]);
      return { canceled: false, filePaths: ["/picked/db.sqlite3"] };
    },
    showSaveDialog: async (_owner, opts) => {
      calls.push(["save", opts]);
      return { canceled: false, filePath: "/picked/out.sql" };
    },
  };
  bridge._setDialogForTests(fakeDialog);
  t.after(() => bridge._setDialogForTests(null));

  const open = await call("quolldesk:sqlite:pickDatabaseFile", { mode: "open" });
  assert.equal(open.ok, true, JSON.stringify(open));
  assert.equal(open.data.path, "/picked/db.sqlite3");
  const dbFilter = calls.find(([kind]) => kind === "open")[1].filters;
  assert.deepEqual(dbFilter[0], { name: "SQLite", extensions: ["db", "sqlite", "sqlite3", "db3"] });
  assert.deepEqual(dbFilter[1], { name: "All", extensions: ["*"] });

  const save = await call("quolldesk:sqlite:pickDatabaseFile", { mode: "save" });
  assert.equal(save.ok, true, JSON.stringify(save));
  assert.equal(save.data.path, "/picked/out.sql");

  // Shared dialog handlers (pickBackupPath/pickRestoreFile) honor the same
  // injection — one _setDialogForTests covers all three pick channels.
  const backupPath = await call("quolldesk:sqlite:pickBackupPath", { defaultName: "dump.sql" });
  assert.equal(backupPath.ok, true, JSON.stringify(backupPath));
  assert.equal(backupPath.data.path, "/picked/out.sql");
  const restoreFile = await call("quolldesk:sqlite:pickRestoreFile");
  assert.equal(restoreFile.ok, true, JSON.stringify(restoreFile));
  assert.equal(restoreFile.data.path, "/picked/db.sqlite3");

  // Cancel maps to a null path on both the local and the shared handler.
  bridge._setDialogForTests({
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  });
  const canceledOpen = await call("quolldesk:sqlite:pickDatabaseFile", { mode: "open" });
  assert.equal(canceledOpen.data.path, null);
  const canceledSave = await call("quolldesk:sqlite:pickDatabaseFile", { mode: "save" });
  assert.equal(canceledSave.data.path, null);
  const canceledBackup = await call("quolldesk:sqlite:pickBackupPath", {});
  assert.equal(canceledBackup.data.path, null);
  const canceledRestore = await call("quolldesk:sqlite:pickRestoreFile");
  assert.equal(canceledRestore.data.path, null);
});

test("test channel closes its probe connection (no registry leak)", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nc-sqlite-bridge-e-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const { call } = setup(68);
  const dbFile = path.join(dir, "probe.db");
  fs.writeFileSync(dbFile, "");
  const ping = await call("quolldesk:sqlite:test", { hostname: dbFile });
  assert.equal(ping.ok, true, JSON.stringify(ping));
  assert.equal(registry.size(), 0, "test channel must not register a connection");
});

test("backup: BLOB columns dump as X'' literals (never ::bytea) and restore byte-identical", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nc-sqlite-bridge-blob-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const { pushes, call } = setup(69);

  const srcFile = path.join(dir, "blob-src.db");
  const conn = await call("quolldesk:sqlite:connect", { hostname: srcFile });
  assert.equal(conn.ok, true, JSON.stringify(conn));
  const connectionId = conn.data.connectionId;

  await call("quolldesk:sqlite:query", {
    connectionId,
    sql: "CREATE TABLE profile(id INTEGER PRIMARY KEY, name TEXT, avatar BLOB)",
  });
  // Insert through the raw driver so a real binary value lands in the BLOB
  // column (node:sqlite reads it back as a Uint8Array; Buffer is a subclass).
  const avatar = Buffer.from([0x00, 0x0d, 0xde, 0xad, 0xbe, 0xef, 0xff]); // NUL + high bytes
  const srcDb = registry.getConnection(connectionId).client.db;
  srcDb.prepare("INSERT INTO profile (id, name, avatar) VALUES (?, ?, ?)").run(1, "ada", avatar);

  const outFile = path.join(dir, "blob-dump.sql");
  const job = await call("quolldesk:sqlite:backup", { connectionId, scope: "table", table: "profile", includeData: true, outFile });
  assert.equal(job.ok, true, JSON.stringify(job));
  await waitForPush(pushes, "done");

  const dump = fs.readFileSync(outFile, "utf8");
  const hex = avatar.toString("hex").toUpperCase();
  assert.ok(dump.includes(`X'${hex}'`), `dump must carry the SQLite binary literal X'${hex}':\n${dump}`);
  assert.ok(!dump.includes("::bytea"), "pg bytea form must never leak into a sqlite dump");
  assert.ok(!dump.includes("\\x"), "pg \\x hex form must never leak into a sqlite dump");

  // Restore into a brand-new database and read the bytes back byte-identical.
  const dstFile = path.join(dir, "restored-blob.db");
  const conn2 = await call("quolldesk:sqlite:connect", { hostname: dstFile });
  assert.equal(conn2.ok, true, JSON.stringify(conn2));
  const connectionId2 = conn2.data.connectionId;
  pushes.length = 0;
  const restore = await call("quolldesk:sqlite:restore", { connectionId: connectionId2, inFile: outFile });
  assert.equal(restore.ok, true, JSON.stringify(restore));
  await waitForPush(pushes, "done");

  const dstDb = registry.getConnection(connectionId2).client.db;
  const row = dstDb.prepare("SELECT name, avatar FROM profile WHERE id = 1").get();
  assert.ok(ArrayBuffer.isView(row.avatar), "restored BLOB must come back as a binary view");
  assert.ok(Buffer.from(row.avatar.buffer, row.avatar.byteOffset, row.avatar.byteLength).equals(avatar),
    "restored BLOB must be byte-identical to the source bytes");
  // Grid path shape: serializeCellValue renders the binary value as JSON text.
  const grid = await call("quolldesk:sqlite:tableRows", { connectionId: connectionId2, table: "profile" });
  const cell = JSON.parse(grid.data.rows[0][2]);
  assert.deepEqual(Object.values(cell), [...avatar]);

  await call("quolldesk:sqlite:disconnect", { connectionId });
  await call("quolldesk:sqlite:disconnect", { connectionId2 });
});

test("INTEGER beyond double precision reads back as a string, no driver throw", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nc-sqlite-bridge-bigint-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const { call } = setup(70);

  const dbFile = path.join(dir, "bigint.db");
  const conn = await call("quolldesk:sqlite:connect", { hostname: dbFile });
  assert.equal(conn.ok, true, JSON.stringify(conn));
  const connectionId = conn.data.connectionId;
  const db = registry.getConnection(connectionId).client.db;
  const BIG = 9007199254740993n; // 2^53 + 1 — unrepresentable as a JS number
  db.exec("CREATE TABLE nums(id INTEGER PRIMARY KEY, big INTEGER)");
  db.prepare("INSERT INTO nums (big) VALUES (?)").run(BIG);

  // Sanity: the raw driver really throws without setReadBigInts on this ABI.
  const probe = db.prepare("SELECT big FROM nums");
  if (typeof probe.setReadBigInts === "function") {
    probe.setReadBigInts(false);
    assert.throws(() => probe.all(), /too large to be represented/i);
  }

  const rows = await call("quolldesk:sqlite:tableRows", { connectionId, table: "nums" });
  assert.equal(rows.ok, true, JSON.stringify(rows));
  assert.equal(rows.data.rows[0][0], "1");
  assert.equal(rows.data.rows[0][1], "9007199254740993", "value must survive as its exact digits");

  const qry = await call("quolldesk:sqlite:query", { connectionId, sql: "SELECT big FROM nums WHERE id = 1" });
  assert.equal(qry.ok, true, JSON.stringify(qry));
  assert.equal(qry.data.resultSets[0].rows[0][0], "9007199254740993");

  await call("quolldesk:sqlite:disconnect", { connectionId });
});
