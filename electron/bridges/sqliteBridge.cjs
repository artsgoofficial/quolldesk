"use strict";

/**
 * SQLite Bridge - GUI client backend.
 * Channels: quolldesk:sqlite:{connect,disconnect,test,schemaTree,tableMeta,tableRows,query,
 *           applyTableChanges,pickBackupPath,pickRestoreFile,backup,restore,pickDatabaseFile}
 * Driver: node:sqlite DatabaseSync (built into system Node 26 / Electron 42; zero deps).
 * hostname 即数据库文件路径(前端 file 表单写入);opts.port 忽略。
 */

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const registry = require("./dbCommon/connectionRegistry.cjs");
const {
  okEnvelope, errorEnvelope, DB_ERROR_CODES, classifyDriverError, serializeCellValue,
} = require("./dbCommon/resultEnvelope.cjs");
const {
  createDumpWriter, sqlLiteral, buildInsertStatements,
  makeJobPusher, abortDump, runSequentialRestore,
} = require("./dbCommon/sqlDump.cjs");
// Task 2's dialect-aware splitter: `splitSqlStatements(sql, "sqlite")` (keeps
// backslashes literal, unlike the mysql-flavored sqlDump splitter).
const { splitSqlStatements } = require("./dbCommon/readOnlySql.cjs");
const { buildGridWhere } = require("./dbCommon/gridWhere.cjs");
const { registerSqlDialogHandlers, _setDialogForTests: setSharedDialogForTests } = require("./dbCommon/dialogHandlers.cjs");
const { reserveDbJob } = require("./dbCommon/dbJobs.cjs");

const MAX_ROWS = 1000;
const MAX_PENDING_CHANGES = 500;
const DUMP_PAGE_SIZE = 500;     // rows per SELECT page
const DUMP_INSERT_BATCH = 100;  // rows per multi-row INSERT statement
const IDENT = /[^A-Za-z0-9_$]/g;
const q = (ident) => '"' + String(ident).replace(IDENT, '""') + '"';

// pickDatabaseFile needs dialog access in this module too; the injection
// forwards to the shared dialogHandlers singleton so one _setDialogForTests
// call in tests covers pickDatabaseFile + pickBackupPath/pickRestoreFile.
let dialogModule = null;
function _setDialogForTests(next) {
  dialogModule = next ?? null;
  setSharedDialogForTests(next);
}
function electronDialog() {
  if (dialogModule) return dialogModule;
  // Lazy require: in the packaged app this is the real electron module.
  return require("electron").dialog;
}

function openDatabase(opts) {
  const filePath = String(opts.hostname || "").trim();
  if (!filePath) throw new Error("database file path is required");
  if (filePath === ":memory:") throw new Error(":memory: is reserved for tests");
  const readOnly = opts.config?.readOnly === true;
  if (!readOnly && !fs.existsSync(filePath)) {
    // 新文件:确认父目录存在(写入才会真正创建文件)。
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } else if (!fs.existsSync(filePath)) {
    throw new Error(`database file does not exist: ${filePath}`);
  }
  const db = new DatabaseSync(filePath, { readOnly });
  try { db.exec("PRAGMA foreign_keys = ON;"); } catch { /* older libsqlite */ }
  return { db, filePath, readOnly };
}

/**
 * sqlite INSERT literal adapter for buildInsertStatements: shared sqlLiteral
 * renders binary values in pg form — Buffer → `'\x..'::bytea` — which SQLite
 * cannot parse, and node:sqlite hands BLOB columns back as Uint8Array (Buffer
 * is a Uint8Array subclass, so one check covers both), which plain sqlLiteral
 * would JSON-stringify into garbage. The SQLite binary literal is
 * X'<upper hex>'. Everything else falls through to sqlLiteral (sqlite reads
 * '\' literally, so no backslash escaping).
 */
function sqliteLiteral(value) {
  if ((typeof Buffer !== "undefined" && Buffer.isBuffer(value)) || value instanceof Uint8Array) {
    return `X'${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex").toUpperCase()}'`;
  }
  return sqlLiteral(value);
}

// SELECT/WITH/PRAGMA/EXPLAIN/VALUES/TABLE → all()(返回结果集);其余 → run()(返回 changes)。
const READ_KEYWORD = /^(select|with|pragma|explain|values|table)\b/i;
function runOne(db, sql, values) {
  if (READ_KEYWORD.test(sql)) {
    const stmt = db.prepare(sql);
    // node:sqlite throws "Value is too large to be represented as a JavaScript
    // number" when a statement reads an INTEGER outside the double-precision
    // range — readBigInts returns those (and, with it enabled, every INTEGER)
    // as BigInt instead; serializeCellValue already stringifies BigInt. The
    // guard keeps older ABI builds without the setter working.
    if (typeof stmt.setReadBigInts === "function") stmt.setReadBigInts(true);
    const rows = values && values.length ? stmt.all(...values) : stmt.all();
    const rawColumns = (typeof stmt.columns === "function" ? stmt.columns() : (rows[0] ? Object.keys(rows[0]) : []));
    const columns = rawColumns.map((c) => ({ name: typeof c === "string" ? c : c.name }));
    return {
      columns,
      rows: rows.slice(0, MAX_ROWS).map((row) => columns.map((c) => serializeCellValue(row?.[c.name]))),
      affectedRows: undefined,
      truncated: rows.length > MAX_ROWS,
    };
  }
  const stmt = db.prepare(sql);
  // Consistent with the read path above; run()'s affected counts come back
  // through Number() below, so BigInt changes are harmless here too.
  if (typeof stmt.setReadBigInts === "function") stmt.setReadBigInts(true);
  const res = values && values.length ? stmt.run(...values) : stmt.run();
  return { columns: [], rows: [], affectedRows: Number(res?.changes ?? 0), truncated: false };
}

/**
 * databaseService (AI/MCP) consumes this: executes exactly ONE statement and
 * returns its single result set wrapped in a one-element array — runAll never
 * splits scripts itself; the caller (databaseService) splits multi-statement
 * SQL with splitSqlStatements first and invokes runAll once per statement.
 * Read-only gating is the caller's responsibility.
 */
function runAll(db, sql) { return [runOne(db, sql)]; }

function toResultSets(db, statements, values) {
  const resultSets = [];
  for (const statement of statements) resultSets.push(runOne(db, statement, values));
  return resultSets;
}

// node:sqlite surfaces SQLITE_READONLY as errcode 8 / "attempt to write a
// readonly database" — classifyDriverError has no pattern for it, so map it to
// PERMISSION_DENIED (the read-only gate refused the write) before the generic
// classifier runs.
function classifySqliteError(err) {
  if (Number(err?.errcode) === 8 || /readonly|read-only/i.test(String(err?.message || ""))) {
    return DB_ERROR_CODES.PERMISSION_DENIED;
  }
  return classifyDriverError(err);
}

/**
 * Stream one connection's tables/views into a plain SQL dump file (shared
 * sqlDump pipeline; INSERT-script form, never a .db file copy). Never throws
 * to the caller: every failure pushes phase:'error' on quolldesk:db:jobProgress
 * and deletes the partial file.
 */
async function runSqliteBackup({ event, db, filePath, connectionId, jobId, scope, table, includeData, outFile }) {
  const writer = createDumpWriter(outFile);
  const { senderAlive, push } = makeJobPusher(event, jobId, "sqlite");
  try {
    await writer.write(
      `-- QuollDesk SQL dump\n-- Dialect: sqlite\n-- Scope: ${scope === "table" ? `table ${table}` : `database ${filePath}`}\n` +
      `-- Generated: ${new Date().toISOString()}\n\nPRAGMA foreign_keys=OFF;\n\n`,
    );

    // Same listing source as schemaTree. ORDER BY type puts tables before
    // views so the view definitions can reference restored tables.
    const listed = db.prepare(
      "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
    ).all();
    const dumpTables = scope === "table"
      ? listed.filter((r) => r.type === "table" && r.name === table)
      : listed.filter((r) => r.type === "table");
    if (scope === "table" && dumpTables.length === 0) throw new Error(`table not found: ${table}`);

    let tablesDone = 0;
    for (const entry of dumpTables) {
      if (!senderAlive()) throw new Error("renderer gone — backup aborted");
      registry.touchConnection(connectionId);
      await push({ phase: "tables", table: entry.name, tablesDone, tablesTotal: dumpTables.length });
      await writer.write(`DROP TABLE IF EXISTS ${q(entry.name)};\n`);
      // sqlite_master.sql is already CREATE TABLE form — no SHOW CREATE step.
      // Explicit indexes are separate sqlite_master rows (auto indexes have
      // sql NULL); DROP TABLE drops them, so only CREATE INDEX is needed.
      if (!entry.sql) throw new Error(`no DDL found for ${entry.name}`);
      await writer.write(`${entry.sql};\n`);
      const indexRows = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name",
      ).all(entry.name);
      for (const idx of indexRows) await writer.write(`${idx.sql};\n`);
      await writer.write("\n");

      if (includeData) {
        const cols = db.prepare(`PRAGMA table_info(${q(entry.name)})`).all().map((c) => c.name);
        // Keyset paging by rowid; WITHOUT ROWID tables (rowid lookup errors —
        // probe once per table) fall back to LIMIT ? OFFSET ? paging.
        let keyset = true;
        try { db.prepare(`SELECT rowid FROM ${q(entry.name)} LIMIT 1`).all(); } catch { keyset = false; }
        let lastRowid = null;
        let rowsDone = 0;
        for (;;) {
          if (!senderAlive()) throw new Error("renderer gone — backup aborted");
          // All three paging shapes feed their row values into sqliteLiteral
          // below, so they read with BigInts enabled (same guard as runOne):
          // an INTEGER column beyond double precision (nanosecond timestamps,
          // 64-bit ids) must not throw mid-backup. BigInt rowid → Number()
          // keeps the keyset cursor working on normal-range rowids.
          const pageStmt = keyset
            ? (lastRowid == null
              ? db.prepare(`SELECT *, rowid AS __qd_rowid__ FROM ${q(entry.name)} ORDER BY rowid LIMIT ?`)
              : db.prepare(`SELECT *, rowid AS __qd_rowid__ FROM ${q(entry.name)} WHERE rowid > ? ORDER BY rowid LIMIT ?`))
            : db.prepare(`SELECT * FROM ${q(entry.name)} LIMIT ? OFFSET ?`);
          if (typeof pageStmt.setReadBigInts === "function") pageStmt.setReadBigInts(true);
          const pageRows = keyset
            ? (lastRowid == null ? pageStmt.all(DUMP_PAGE_SIZE) : pageStmt.all(lastRowid, DUMP_PAGE_SIZE))
            : pageStmt.all(DUMP_PAGE_SIZE, rowsDone);
          if (pageRows.length > 0) {
            // value arrays in table_info column order (raw driver values —
            // sqliteLiteral renders numbers/strings, BLOBs as X'<hex>';
            // sqlite reads '\' literally, so no backslash escaping).
            const valueRows = pageRows.map((row) => cols.map((name) => row[name]));
            const statements = buildInsertStatements({
              tableRef: q(entry.name), quote: q, columns: cols, rows: valueRows,
              literal: sqliteLiteral,
              batchSize: DUMP_INSERT_BATCH,
            });
            for (const statement of statements) await writer.write(statement + "\n");
            if (keyset) lastRowid = Number(pageRows[pageRows.length - 1].__qd_rowid__);
          }
          rowsDone += pageRows.length;
          if (pageRows.length < DUMP_PAGE_SIZE) break;
          await push({ phase: "rows", table: entry.name, rowsDone });
        }
        await push({ phase: "rows", table: entry.name, rowsDone });
      }
      tablesDone += 1;
    }

    // Views are emitted AFTER all tables so their base tables exist at
    // CREATE VIEW time.
    if (scope === "database") {
      await push({ phase: "views" });
      for (const view of listed.filter((r) => r.type === "view")) {
        if (!senderAlive()) throw new Error("renderer gone — backup aborted");
        await writer.write(`DROP VIEW IF EXISTS ${q(view.name)};\n${view.sql};\n\n`);
      }
    }

    await writer.write("\nPRAGMA foreign_keys=ON;\n");
    await writer.end();
    push({ phase: "done", message: `dumped ${tablesDone} table(s) to ${outFile}`, tablesDone });
  } catch (err) {
    await abortDump(writer, outFile);
    if (senderAlive()) {
      push({ phase: "error", error: err?.message || "backup failed", message: err?.message || "backup failed" });
    }
  }
}

function registerHandlers(ipcMain, options = {}) {
  ipcMain.handle("quolldesk:sqlite:connect", async (event, opts = {}) => {
    const filePath = String(opts.hostname || "").trim();
    if (!filePath) return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, "hostname (database file path) is required");
    try {
      const { db, filePath, readOnly } = openDatabase(opts);
      const connectionId = registry.registerConnection({
        dialect: "sqlite",
        senderId: event.sender.id,
        client: { db, filePath, readOnly },
        tunnel: null,
        meta: {
          hostname: filePath,
          port: null,
          database: path.basename(filePath),
          username: null,
        },
        close: () => {
          try { db.close(); } catch { /* ignore */ }
        },
      });
      // No watchDriverDeath: DatabaseSync has no death event; a deleted file
      // surfaces on the next statement and classifySqliteError covers it.
      return okEnvelope({ connectionId });
    } catch (err) {
      return errorEnvelope(classifySqliteError(err), err?.message || "connect failed");
    }
  });

  ipcMain.handle("quolldesk:sqlite:disconnect", async (_event, { connectionId } = {}) => {
    if (!connectionId) return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, "connectionId required");
    registry.closeConnection(connectionId, "user");
    return okEnvelope({});
  });

  ipcMain.handle("quolldesk:sqlite:test", async (_event, opts = {}) => {
    const filePath = String(opts.hostname || "").trim();
    if (!filePath) return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, "hostname (database file path) is required");
    let dialed = null;
    const started = Date.now();
    try {
      dialed = openDatabase(opts);
      const row = dialed.db.prepare("SELECT sqlite_version() AS v").get();
      return okEnvelope({
        latencyMs: Date.now() - started,
        serverVersion: String(row?.v || "unknown"),
      });
    } catch (err) {
      return errorEnvelope(classifySqliteError(err), err?.message || "test failed");
    } finally {
      if (dialed) { try { dialed.db.close(); } catch { /* ignore */ } }
    }
  });

  ipcMain.handle("quolldesk:sqlite:schemaTree", async (_event, { connectionId } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry) return errorEnvelope(DB_ERROR_CODES.NOT_CONNECTED, "not connected");
    registry.touchConnection(connectionId);
    try {
      const rows = entry.client.db.prepare(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all();
      const base = path.basename(entry.client.filePath);
      const tables = rows.filter((r) => r.type === "table").map((r) => r.name);
      const views = rows.filter((r) => r.type === "view").map((r) => r.name);
      return okEnvelope({ databases: [{ name: base, tables, views }] });
    } catch (err) {
      return errorEnvelope(classifySqliteError(err), err?.message || "schemaTree failed");
    }
  });

  ipcMain.handle("quolldesk:sqlite:tableMeta", async (_event, { connectionId, table } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry || !table) return errorEnvelope(entry ? DB_ERROR_CODES.INVALID_PARAMS : DB_ERROR_CODES.NOT_CONNECTED, entry ? "table required" : "not connected");
    registry.touchConnection(connectionId);
    const db = entry.client.db;
    try {
      // PRAGMA statements cannot be parameterized — the identifier is quoted
      // into the pragma text with q() (doubled inner quotes).
      const columns = db.prepare(`PRAGMA table_info(${q(table)})`).all().map((c) => ({
        name: c.name, type: c.type, nullable: c.notnull === 0, key: c.pk > 0 ? "PRI" : null, defaultValue: c.dflt_value,
      }));
      const pkCols = db.prepare(`PRAGMA table_info(${q(table)})`).all()
        .filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      const indexes = db.prepare(`PRAGMA index_list(${q(table)})`).all().map((idx) => ({
        name: idx.name, unique: idx.unique === 1,
        columns: db.prepare(`PRAGMA index_info(${q(idx.name)})`).all().map((c) => c.name),
        method: "btree",
      }));
      const ddlRow = db.prepare("SELECT sql FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(table);
      const fks = db.prepare(`PRAGMA foreign_key_list(${q(table)})`).all()
        .filter((f) => f.table).map((f) => ({ column: f.from, refTable: f.table, refColumn: f.to ?? null }));
      const count = db.prepare(`SELECT COUNT(*) AS c FROM ${q(table)}`).get();
      return okEnvelope({
        columns, indexes,
        primaryKey: pkCols.length ? { name: "PRIMARY", columns: pkCols } : null,
        ddl: ddlRow?.sql ?? null, foreignKeys: fks,
        rowCountEstimate: Number(count?.c ?? 0),
      });
    } catch (err) {
      return errorEnvelope(classifySqliteError(err), err?.message || "tableMeta failed");
    }
  });

  ipcMain.handle("quolldesk:sqlite:tableRows", async (_event, { connectionId, table, orderBy, orderDir, filters, offset = 0, limit = 100 } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry || !table) return errorEnvelope(entry ? DB_ERROR_CODES.INVALID_PARAMS : DB_ERROR_CODES.NOT_CONNECTED, entry ? "table required" : "not connected");
    registry.touchConnection(connectionId);
    const pageLimit = Math.min(Math.max(1, Number(limit) || 100), MAX_ROWS);
    const dir = orderDir === "asc" ? " ASC" : orderDir === "desc" ? " DESC" : "";
    const order = orderBy ? ` ORDER BY ${q(orderBy)}${dir}` : "";
    const { where, values } = buildGridWhere(filters, { quote: q, placeholder: () => "?" });
    try {
      const rs = runOne(entry.client.db,
        `SELECT * FROM ${q(table)}${where}${order} LIMIT ? OFFSET ?`,
        [...values, pageLimit, Math.max(0, Number(offset) || 0)]);
      return okEnvelope({ columns: rs.columns, rows: rs.rows, truncated: rs.truncated });
    } catch (err) {
      return errorEnvelope(classifySqliteError(err), err?.message || "tableRows failed");
    }
  });

  // Apply pending grid edits transactionally: updates/inserts/deletes run
  // inside one BEGIN IMMEDIATE transaction and roll back together on failure.
  ipcMain.handle("quolldesk:sqlite:applyTableChanges", async (_event, { connectionId, table, changes = {} } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry || !table) return errorEnvelope(entry ? DB_ERROR_CODES.INVALID_PARAMS : DB_ERROR_CODES.NOT_CONNECTED, entry ? "table required" : "not connected");
    const updates = Array.isArray(changes.updates) ? changes.updates : [];
    const inserts = Array.isArray(changes.inserts) ? changes.inserts : [];
    const deletes = Array.isArray(changes.deletes) ? changes.deletes : [];
    const total = updates.length + inserts.length + deletes.length;
    if (total === 0) return okEnvelope({ applied: { updates: 0, inserts: 0, deletes: 0 } });
    if (total > MAX_PENDING_CHANGES) return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, `too many pending changes (${total} > ${MAX_PENDING_CHANGES})`);
    registry.touchConnection(connectionId);
    const db = entry.client.db;
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const applied = { updates: 0, inserts: 0, deletes: 0 };
        for (const u of updates) {
          if (!u.pk || !u.column || u.pkValue == null) throw new Error("invalid update entry");
          db.prepare(`UPDATE ${q(table)} SET ${q(u.column)} = ? WHERE ${q(u.pk)} = ?`).run(u.value === null ? null : String(u.value), String(u.pkValue));
          applied.updates += 1;
        }
        for (const ins of inserts) {
          const cols = Object.keys(ins.values || {});
          if (!cols.length) continue;
          db.prepare(`INSERT INTO ${q(table)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
            .run(...cols.map((c) => (ins.values[c] === null ? null : String(ins.values[c]))));
          applied.inserts += 1;
        }
        for (const d of deletes) {
          if (!d.pk || d.pkValue == null) throw new Error("invalid delete entry");
          db.prepare(`DELETE FROM ${q(table)} WHERE ${q(d.pk)} = ?`).run(String(d.pkValue));
          applied.deletes += 1;
        }
        db.exec("COMMIT");
        return okEnvelope({ applied });
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw err;
      }
    } catch (err) {
      return errorEnvelope(classifySqliteError(err), err?.message || "apply failed");
    }
  });

  ipcMain.handle("quolldesk:sqlite:query", async (_event, { connectionId, sql } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry || !sql || !String(sql).trim()) {
      return errorEnvelope(entry ? DB_ERROR_CODES.INVALID_PARAMS : DB_ERROR_CODES.NOT_CONNECTED, entry ? "sql required" : "not connected");
    }
    registry.touchConnection(connectionId);
    const started = Date.now();
    try {
      // timeoutMs 不适用本地文件连接,忽略。
      const statements = splitSqlStatements(String(sql), "sqlite");
      const resultSets = toResultSets(entry.client.db, statements);
      return okEnvelope({
        resultSets,
        executionTimeMs: Date.now() - started,
        truncated: resultSets.some((rs) => rs.truncated),
      });
    } catch (err) {
      return errorEnvelope(classifySqliteError(err), err?.message || "query failed");
    }
  });

  // ---- Backup / restore ----

  registerSqlDialogHandlers(ipcMain, "quolldesk:sqlite");

  // Async dump job: the invoke returns { jobId } immediately; progress and
  // completion arrive on quolldesk:db:jobProgress. One job per connection.
  ipcMain.handle("quolldesk:sqlite:backup", async (event, { connectionId, scope = "database", table, includeData = true, outFile } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry) return errorEnvelope(DB_ERROR_CODES.NOT_CONNECTED, "not connected");
    if (scope !== "database" && scope !== "table") {
      return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, "scope must be 'database' or 'table'");
    }
    if (scope === "table" && !table) return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, "table required for table scope");
    if (!outFile || typeof outFile !== "string") return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, "outFile required");
    const job = reserveDbJob(connectionId, "backup already in progress");
    if (job.error) return job.error;
    registry.touchConnection(connectionId);
    void runSqliteBackup({
      event, db: entry.client.db, filePath: entry.client.filePath, connectionId,
      jobId: job.jobId, scope, table, includeData, outFile,
    }).finally(job.release);
    return okEnvelope({ jobId: job.jobId });
  });

  // File restore: reads the SQL file, splits it with the quote/comment-aware
  // splitter and executes statements sequentially. Already-executed statements
  // stay applied on a mid-file error (reported with its statement index).
  ipcMain.handle("quolldesk:sqlite:restore", async (event, { connectionId, inFile } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry) return errorEnvelope(DB_ERROR_CODES.NOT_CONNECTED, "not connected");
    if (!inFile || typeof inFile !== "string") return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, "inFile required");
    const job = reserveDbJob(connectionId, "restore already in progress");
    if (job.error) return job.error;
    let text;
    try {
      text = await fs.promises.readFile(inFile, "utf8");
    } catch (err) {
      job.release();
      return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, `cannot read SQL file: ${err?.message || inFile}`);
    }
    const statements = splitSqlStatements(text, "sqlite");
    registry.touchConnection(connectionId);
    void runSequentialRestore({
      event, jobId: job.jobId, dialect: "sqlite", statements,
      exec: (statement) => entry.client.db.exec(statement),
    }).finally(job.release);
    return okEnvelope({ jobId: job.jobId });
  });

  // File picker for the SQLite "database file" form field (frontend has no
  // fs access): mode 'open' picks an existing .db file, mode 'save' picks
  // where a new one is created (promptToCreate lets the user type a name).
  ipcMain.handle("quolldesk:sqlite:pickDatabaseFile", async (event, { mode = "open" } = {}) => {
    try {
      const dialog = electronDialog();
      const filters = [
        { name: "SQLite", extensions: ["db", "sqlite", "sqlite3", "db3"] },
        { name: "All", extensions: ["*"] },
      ];
      if (mode === "save") {
        if (!dialog?.showSaveDialog) return errorEnvelope(DB_ERROR_CODES.INTERNAL, "dialog unavailable");
        const result = await dialog.showSaveDialog(undefined, { defaultPath: "database.db", filters });
        const picked = !result?.canceled && result?.filePath ? result.filePath : null;
        return okEnvelope({ path: picked });
      }
      if (!dialog?.showOpenDialog) return errorEnvelope(DB_ERROR_CODES.INTERNAL, "dialog unavailable");
      const result = await dialog.showOpenDialog(undefined, { filters, properties: ["openFile", "promptToCreate"] });
      const picked = !result?.canceled && Array.isArray(result?.filePaths) && result.filePaths[0] ? result.filePaths[0] : null;
      return okEnvelope({ path: picked });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "pickDatabaseFile failed");
    }
  });
}

function closeAllForSender(senderId) { return registry.closeAllForSender(senderId); }

module.exports = {
  registerHandlers, closeAllForSender, _setDialogForTests,
  openDatabase, runOne, runAll, toResultSets, classifySqliteError,
};
