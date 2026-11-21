"use strict";

// mysql2 家族共享驱动核心(mysql / mariadb 两桥实例化)。差异点只有两个注入参数:
// channel → IPC 频道前缀 `quolldesk:${channel}:*`;dialect → registry 条目、
// jobProgress payload、dump 头注释、databaseService 元数据路由。
// Channels: quolldesk:${channel}:{connect,disconnect,test,schemaTree,tableMeta,tableRows,query,applyTableChanges,
//           pickBackupPath,pickRestoreFile,backup,restore}

const { randomUUID } = require("node:crypto");
const fs = require("node:fs");

const registry = require("./connectionRegistry.cjs");
const { openDbTunnel } = require("./tunnel.cjs");
const {
  okEnvelope, errorEnvelope, DB_ERROR_CODES, classifyDriverError, serializeCellValue,
} = require("./resultEnvelope.cjs");
const {
  createDumpWriter, sqlLiteral, escapeSqlString, buildInsertStatements,
  splitSqlStatements, makeJobPusher, abortDump, runSequentialRestore,
} = require("./sqlDump.cjs");
const { buildGridWhere } = require("./gridWhere.cjs");
const { registerSqlDialogHandlers, _setDialogForTests } = require("./dialogHandlers.cjs");
const { reserveDbJob } = require("./dbJobs.cjs");
const { watchDriverDeath } = require("./closeNotifier.cjs");

function createMysqlFamilyBridge({ channel, dialect }) {
  const MAX_ROWS = 1000;
  const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
  const IDENT = /[^A-Za-z0-9_$]/g;
  const q = (ident) => "`" + String(ident).replace(IDENT, "``") + "`";

  // mysql2 is only needed once a MySQL session actually dials; load it lazily so
  // the app boot path never pays for the driver parse (a broken driver install
  // then only breaks MySQL sessions, not the whole app).
  let driver = null;
  function getDriver() {
    if (driver === null) driver = require("mysql2");
    return driver;
  }
  function _setDriverForTests(next) { driver = next ?? require("mysql2"); }

  // ---- Backup / restore (Wave 6) ----
  const DUMP_PAGE_SIZE = 500;     // rows per SELECT page
  const DUMP_INSERT_BATCH = 100;  // rows per multi-row INSERT statement

  async function dial(event, opts) {
    let tunnel = null;
    if (opts.ssh) {
      // Unique per-attempt token: concurrent dials must not collide on the pool leaseId.
      tunnel = await openDbTunnel({
        event, ssh: opts.ssh, targetHost: opts.hostname, targetPort: opts.port, connectionId: randomUUID(),
      });
    }
    const config = opts.config || {};
    const connOpts = {
      host: opts.hostname,
      port: opts.port,
      user: opts.username,
      password: opts.password,
      database: config.database || undefined,
      multipleStatements: true,
      connectTimeout: 10_000,
      ...(tunnel ? { stream: tunnel.socket } : {}),
      ...(config.tls ? { ssl: { rejectUnauthorized: !config.tlsInsecure } } : {}),
    };
    try {
      const conn = getDriver().createConnection(connOpts);
      await new Promise((resolve, reject) => conn.connect((err) => (err ? reject(err) : resolve())));
      return { conn, tunnel };
    } catch (err) {
      try { if (tunnel) tunnel.release(); } catch { /* ignore */ }
      throw err;
    }
  }

  /**
   * Execute one query and segment its event stream into per-statement results
   * (`multipleStatements: true` means several statements can run per query).
   * Resolves to an array of `{ rows, columns, okPacket, truncated }` segments;
   * a new segment starts whenever a `fields` event arrives for a segment that
   * already received columns, rows or an ok packet.
   */
  const MAX_PENDING_CHANGES = 500;

  // FK metadata (SqlTableData jump-through): SHOW CREATE TABLE renders foreign
  // keys as CONSTRAINT `name` FOREIGN KEY (`col`) REFERENCES `schema`.`table`
  // (`col`). Schema-qualified refs capture refSchema; plain refs leave it
  // undefined. Global flag regex — reset lastIndex before each scan.
  const FK_PATTERN = /FOREIGN KEY\s*\(`([^`]+)`\)\s*REFERENCES\s*(?:`([^`]+)`\.)?`([^`]+)`\s*\(`([^`]+)`\)/g;

  function parseForeignKeys(ddl) {
    const fks = [];
    if (typeof ddl !== "string") return fks;
    FK_PATTERN.lastIndex = 0;
    let match;
    while ((match = FK_PATTERN.exec(ddl)) !== null) {
      const fk = { column: match[1], refTable: match[3], refColumn: match[4] };
      if (match[2]) fk.refSchema = match[2];
      fks.push(fk);
    }
    return fks;
  }

  /**
   * Execute one write statement and count affected rows. Same event-mode shape
   * as runQuery so it works against the real driver and the EventEmitter fake.
   */
  function runWrite(conn, sql, values) {
    return new Promise((resolve, reject) => {
      const query = conn.query({ sql, values });
      let finished = false;
      let affected = 0;
      const finish = (err) => {
        if (finished) return;
        finished = true;
        if (err) reject(err);
        else resolve({ affected });
      };
      const countOk = (row) => {
        if (row && typeof row === "object" && "affectedRows" in row) affected += Number(row.affectedRows) || 0;
      };
      const stream = query.stream ? query.stream({}) : null;
      if (!stream) {
        query.on("error", finish);
        query.on("result", countOk);
        query.on("end", () => finish(null));
        return;
      }
      stream.on("error", finish);
      query.on("error", finish);
      stream.on("data", countOk);
      stream.on("end", () => finish(null));
    });
  }

  function runQuery(conn, sql, timeoutMs, values = undefined) {
    return new Promise((resolve, reject) => {
      const query = conn.query({ sql, values, timeout: timeoutMs });
      const segments = [];
      let current = null;
      let finished = false;
      const newSegment = () => {
        current = { rows: [], columns: null, okPacket: null, truncated: false };
        segments.push(current);
      };
      newSegment();
      const finish = (err) => {
        if (finished) return;
        finished = true;
        if (err) reject(err);
        else resolve(segments);
      };
      const handleResult = (row) => {
        // OK packets (UPDATE/INSERT/DELETE) arrive as result rows without fields.
        if (!current.columns && row && typeof row === "object" && "affectedRows" in row) {
          current.okPacket = row;
          return;
        }
        current.rows.push(row);
        if (current.rows.length >= MAX_ROWS) { current.truncated = true; query.destroy?.(); }
      };
      const handleFields = (fields) => {
        if (current.columns || current.rows.length || current.okPacket) newSegment();
        current.columns = fields;
      };
      const stream = query.stream ? query.stream({}) : null;
      if (!stream) {
        // Event mode (mysql2 stream events without a Node stream, and the test fake).
        query.on("error", finish);
        query.on("fields", handleFields);
        query.on("result", handleResult);
        query.on("end", () => finish(null));
        return;
      }
      stream.on("error", finish);
      query.on("error", finish);
      query.on("fields", handleFields);
      stream.on("data", (row) => {
        if (!current.columns) { handleResult(row); return; }
        current.rows.push(row);
        if (current.rows.length >= MAX_ROWS) { current.truncated = true; stream.destroy?.(); query.destroy?.(); }
      });
      stream.on("end", () => finish(null));
    });
  }

  function toResultSet(partial) {
    const columns = (partial.columns || []).map((f) => ({ name: f.name ?? f.Field ?? String(f) }));
    if (!columns.length) {
      return { columns: [], rows: [], affectedRows: partial.okPacket?.affectedRows, truncated: !!partial.truncated };
    }
    const rows = (partial.rows || []).map((row) =>
      Array.isArray(row) ? row : columns.map((c) => serializeCellValue(row?.[c.name])));
    return { columns, rows, affectedRows: undefined, truncated: !!partial.truncated };
  }

  /**
   * Stream one connection's tables/views into a plain SQL dump file.
   * Never throws to the caller: every failure path pushes phase:'error' on
   * quolldesk:db:jobProgress and deletes the partial file. Pushes stop (and the
   * job aborts) as soon as the renderer that started the job is gone.
   */
  async function runMysqlFamilyBackup({ event, conn, connectionId, jobId, scope, table, includeData, outFile }) {
    const writer = createDumpWriter(outFile);
    const { senderAlive, push } = makeJobPusher(event, jobId, dialect);
    try {
      const [dbSeg] = await runQuery(conn, "SELECT DATABASE() AS db", DEFAULT_QUERY_TIMEOUT_MS);
      const dbName = dbSeg.rows[0]?.db || null;
      if (!dbName) throw new Error("no database selected on this connection");

      await writer.write(
        `-- QuollDesk SQL dump\n-- Dialect: ${dialect}\n-- Scope: ${scope === "table" ? `table ${table}` : `database ${dbName}`}\n` +
        `-- Generated: ${new Date().toISOString()}\n\nSET FOREIGN_KEY_CHECKS=0;\n\n`,
      );

      // Same listing source as schemaTree: information_schema.TABLES per db.
      const escapedDb = escapeSqlString(dbName, { escapeBackslash: true });
      const listed = (await runQuery(conn,
        `SELECT TABLE_NAME AS name, TABLE_TYPE AS kind FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${escapedDb}' ORDER BY TABLE_NAME`,
        DEFAULT_QUERY_TIMEOUT_MS))[0].rows;
      const dumpTables = scope === "table"
        ? listed.filter((r) => r.name === table)
        : listed.filter((r) => String(r.kind).toUpperCase() !== "VIEW");
      if (scope === "table" && dumpTables.length === 0) throw new Error(`table not found: ${table}`);

      let tablesDone = 0;
      for (const entry of dumpTables) {
        if (!senderAlive()) throw new Error("renderer gone — backup aborted");
        registry.touchConnection(connectionId);
        await push({ phase: "tables", table: entry.name, tablesDone, tablesTotal: dumpTables.length });
        const tbl = `${q(dbName)}.${q(entry.name)}`;
        await writer.write(`DROP TABLE IF EXISTS ${q(entry.name)};\n`);
        const [ddlSeg] = await runQuery(conn, `SHOW CREATE TABLE ${tbl}`, DEFAULT_QUERY_TIMEOUT_MS);
        const ddl = ddlSeg.rows[0]?.["Create Table"];
        if (!ddl) throw new Error(`SHOW CREATE TABLE failed for ${entry.name}`);
        await writer.write(`${ddl};\n\n`);

        if (includeData) {
          // PK inference mirrors the grid's apply path: SHOW COLUMNS Key='PRI'
          // (composite PKs order by all PRI columns; without a PK rows stream
          // unordered via a plain SELECT).
          const [colSeg] = await runQuery(conn, `SHOW COLUMNS FROM ${tbl}`, DEFAULT_QUERY_TIMEOUT_MS);
          const pkCols = colSeg.rows.filter((c) => c.Key === "PRI").map((c) => c.Field);
          const order = pkCols.length ? ` ORDER BY ${pkCols.map(q).join(", ")}` : "";
          const literal = (v) => sqlLiteral(v, { escapeBackslash: true });
          // Keyset cursor: the last page's PK values. Resuming with
          // `(pk…) > (last…)` avoids OFFSET re-scanning all prior rows per page.
          let lastPkValues = null;
          let rowsDone = 0;
          for (;;) {
            if (!senderAlive()) throw new Error("renderer gone — backup aborted");
            const keyset = pkCols.length && lastPkValues
              ? ` WHERE (${pkCols.map(q).join(", ")}) > (${lastPkValues.map(literal).join(", ")})`
              : "";
            const [page] = await runQuery(conn,
              `SELECT * FROM ${tbl}${keyset}${order} LIMIT ${DUMP_PAGE_SIZE}`,
              DEFAULT_QUERY_TIMEOUT_MS);
            const rows = page.rows || [];
            if (rows.length > 0) {
              // runQuery yields row OBJECTS; the INSERT builder needs value
              // arrays in column order (raw driver values — sqlLiteral renders
              // Dates/Buffers/numbers).
              const columns = (page.columns || []).map((f) => f.name).filter(Boolean);
              const valueRows = rows.map((row) => columns.map((name) => (row == null ? null : row[name])));
              const statements = buildInsertStatements({
                tableRef: tbl, quote: q, columns, rows: valueRows,
                literal,
                batchSize: DUMP_INSERT_BATCH,
              });
              for (const statement of statements) await writer.write(statement + "\n");
              if (pkCols.length) {
                const lastRow = rows[rows.length - 1];
                lastPkValues = lastRow == null ? null : pkCols.map((name) => lastRow[name]);
              }
            }
            rowsDone += rows.length;
            if (rows.length < DUMP_PAGE_SIZE) break;
            await push({ phase: "rows", table: entry.name, rowsDone });
          }
          await push({ phase: "rows", table: entry.name, rowsDone });
        }
        tablesDone += 1;
      }

      // Views are emitted AFTER all tables so their base tables exist at
      // CREATE VIEW time. DEFINER clauses in SHOW CREATE VIEW output are kept
      // as-is (restoring as a different user may need manual edits).
      if (scope === "database") {
        await push({ phase: "views" });
        const viewRows = (await runQuery(conn, "SHOW FULL TABLES WHERE Table_type='VIEW'", DEFAULT_QUERY_TIMEOUT_MS))[0].rows;
        for (const row of viewRows) {
          if (!senderAlive()) throw new Error("renderer gone — backup aborted");
          const keys = Object.keys(row);
          const name = keys.length ? row[keys[0]] : null;
          if (!name) continue;
          await writer.write(`DROP VIEW IF EXISTS ${q(name)};\n`);
          const [defSeg] = await runQuery(conn, `SHOW CREATE VIEW ${q(dbName)}.${q(name)}`, DEFAULT_QUERY_TIMEOUT_MS);
          const def = defSeg.rows[0]?.["Create View"];
          if (!def) throw new Error(`SHOW CREATE VIEW failed for ${name}`);
          await writer.write(`${def};\n\n`);
        }
      }

      await writer.write("\nSET FOREIGN_KEY_CHECKS=1;\n");
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
    ipcMain.handle(`quolldesk:${channel}:connect`, async (event, opts = {}) => {
      if (!opts.hostname || !Number.isInteger(opts.port)) {
        return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, "hostname and integer port are required");
      }
      try {
        const { conn, tunnel } = await dial(event, opts);
        const connectionId = registry.registerConnection({
          dialect,
          senderId: event.sender.id,
          client: { conn },
          tunnel,
          meta: {
            hostname: opts.hostname,
            port: opts.port,
            database: opts.config?.database ?? null,
            username: opts.username ?? null,
          },
          close: () => {
            try { conn.end(); } catch { try { conn.destroy(); } catch { /* ignore */ } }
            if (tunnel) tunnel.release();
          },
        });
        watchDriverDeath(conn, connectionId, registry);
        return okEnvelope({ connectionId });
      } catch (err) {
        return errorEnvelope(classifyDriverError(err), err?.message || "connect failed");
      }
    });

    ipcMain.handle(`quolldesk:${channel}:disconnect`, async (_event, { connectionId } = {}) => {
      if (!connectionId) return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, "connectionId required");
      registry.closeConnection(connectionId, "user");
      return okEnvelope({});
    });

    ipcMain.handle(`quolldesk:${channel}:test`, async (event, opts = {}) => {
      if (!opts.hostname || !Number.isInteger(opts.port)) {
        return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, "hostname and integer port are required");
      }
      let dialed = null;
      const started = Date.now();
      try {
        dialed = await dial(event, opts);
        const [partial] = await runQuery(dialed.conn, "SELECT VERSION() AS v", 10_000);
        const rows = Array.isArray(partial.rows) ? partial.rows : [partial.rows];
        return okEnvelope({
          latencyMs: Date.now() - started,
          serverVersion: String(rows[0]?.v || "unknown"),
        });
      } catch (err) {
        return errorEnvelope(classifyDriverError(err), err?.message || "test failed");
      } finally {
        if (dialed) { try { dialed.conn.end(); } catch { /* ignore */ } try { dialed.tunnel?.release(); } catch { /* ignore */ } }
      }
    });

    ipcMain.handle(`quolldesk:${channel}:schemaTree`, async (_event, { connectionId } = {}) => {
      const entry = registry.getConnection(connectionId);
      if (!entry) return errorEnvelope(DB_ERROR_CODES.NOT_CONNECTED, "not connected");
      registry.touchConnection(connectionId);
      try {
        // One round trip: every schema joined with its tables/views (the LEFT
        // JOIN keeps empty schemas in the tree). Replaces the per-schema N+1
        // listing — on many-schema servers that was one query per schema.
        // System schemas are excluded to match the pg bridge's tree, so the
        // user's own schemas stay visible without scrolling past 60+ system
        // tables (they remain reachable via SQL).
        const rows = (await runQuery(entry.client.conn,
          "SELECT s.SCHEMA_NAME AS name, t.TABLE_NAME AS table_name, t.TABLE_TYPE AS kind " +
          "FROM information_schema.SCHEMATA s LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME " +
          "WHERE s.SCHEMA_NAME NOT IN ('information_schema', 'performance_schema', 'sys', 'mysql') " +
          "ORDER BY s.SCHEMA_NAME, t.TABLE_NAME",
          DEFAULT_QUERY_TIMEOUT_MS))[0].rows;
        const databases = [];
        let current = null;
        for (const row of rows) {
          if (!current || current.name !== row.name) {
            current = { name: row.name, tables: [], views: [] };
            databases.push(current);
          }
          if (row.table_name == null) continue; // empty schema: no TABLES match
          if (String(row.kind).toUpperCase() === "VIEW") current.views.push(row.table_name);
          else current.tables.push(row.table_name);
        }
        return okEnvelope({ databases });
      } catch (err) {
        return errorEnvelope(classifyDriverError(err), err?.message || "schemaTree failed");
      }
    });

    ipcMain.handle(`quolldesk:${channel}:tableMeta`, async (_event, { connectionId, table, schema } = {}) => {
      const entry = registry.getConnection(connectionId);
      if (!entry || !table) return errorEnvelope(entry ? DB_ERROR_CODES.INVALID_PARAMS : DB_ERROR_CODES.NOT_CONNECTED, entry ? "table required" : "not connected");
      registry.touchConnection(connectionId);
      const tbl = q(table);
      const db = schema ? q(schema) : null;
      const where = schema
        ? ` WHERE TABLE_SCHEMA = '${escapeSqlString(schema, { escapeBackslash: true })}' AND TABLE_NAME = '${escapeSqlString(table, { escapeBackslash: true })}'`
        : ` WHERE TABLE_NAME = '${escapeSqlString(table, { escapeBackslash: true })}'`;
      try {
        const [columns, indexes, ddl, count] = await Promise.all([
          runQuery(entry.client.conn, `SHOW COLUMNS FROM ${db ? db + "." : ""}${tbl}`, DEFAULT_QUERY_TIMEOUT_MS),
          runQuery(entry.client.conn, `SHOW INDEX FROM ${db ? db + "." : ""}${tbl}`, DEFAULT_QUERY_TIMEOUT_MS),
          runQuery(entry.client.conn, `SHOW CREATE TABLE ${db ? db + "." : ""}${tbl}`, DEFAULT_QUERY_TIMEOUT_MS),
          runQuery(entry.client.conn,
            `SELECT TABLE_ROWS AS c FROM information_schema.TABLES${where}`, DEFAULT_QUERY_TIMEOUT_MS),
        ]);
        const seen = new Map();
        for (const row of indexes[0].rows) {
          const name = row.Key_name;
          const entryIdx = seen.get(name) || { name, columns: [], unique: Number(row.Non_unique) === 0, method: String(row.Index_type || "") };
          entryIdx.columns.push(row.Column_name);
          seen.set(name, entryIdx);
        }
        // The PK constraint is always named PRIMARY in mysql; columns carry the
        // PRI flag. primaryKey mirrors the pg payload (designer/grid consume it
        // uniformly instead of re-deriving the PK per dialect).
        const pkCols = columns[0].rows.filter((c) => c.Key === "PRI").map((c) => c.Field);
        const ddlText = ddl[0].rows[0]?.["Create Table"] || ddl[0].rows[0]?.["Create View"] || null;
        return okEnvelope({
          columns: columns[0].rows.map((c) => ({
            name: c.Field, type: c.Type, nullable: c.Null === "YES", key: c.Key || null, defaultValue: c.Default,
          })),
          indexes: [...seen.values()],
          primaryKey: pkCols.length > 0 ? { name: "PRIMARY", columns: pkCols } : null,
          ddl: ddlText,
          foreignKeys: parseForeignKeys(ddlText),
          rowCountEstimate: Number(count[0].rows[0]?.c ?? 0),
        });
      } catch (err) {
        return errorEnvelope(classifyDriverError(err), err?.message || "tableMeta failed");
      }
    });

    ipcMain.handle(`quolldesk:${channel}:tableRows`, async (_event, { connectionId, table, schema, orderBy, orderDir, filters, offset = 0, limit = 100 } = {}) => {
      const entry = registry.getConnection(connectionId);
      if (!entry || !table) return errorEnvelope(entry ? DB_ERROR_CODES.INVALID_PARAMS : DB_ERROR_CODES.NOT_CONNECTED, entry ? "table required" : "not connected");
      registry.touchConnection(connectionId);
      const pageLimit = Math.min(Math.max(1, Number(limit) || 100), MAX_ROWS);
      const tbl = `${schema ? q(schema) + "." : ""}${q(table)}`;
      const dir = orderDir === "asc" ? " ASC" : orderDir === "desc" ? " DESC" : "";
      const order = orderBy ? ` ORDER BY ${q(orderBy)}${dir}` : "";
      const { where, values } = buildGridWhere(filters, { quote: q, placeholder: () => "?" });
      try {
        const [partial] = await runQuery(entry.client.conn,
          `SELECT * FROM ${tbl}${where}${order} LIMIT ${pageLimit} OFFSET ${Math.max(0, Number(offset) || 0)}`,
          DEFAULT_QUERY_TIMEOUT_MS,
          values.length ? values : undefined);
        const rs = toResultSet(partial);
        return okEnvelope({ columns: rs.columns, rows: rs.rows, truncated: rs.truncated });
      } catch (err) {
        return errorEnvelope(classifyDriverError(err), err?.message || "tableRows failed");
      }
    });

    // Apply pending grid edits transactionally: updates/inserts/deletes run
    // inside one transaction and roll back together on any failure.
    ipcMain.handle(`quolldesk:${channel}:applyTableChanges`, async (_event, { connectionId, table, schema, changes = {} } = {}) => {
      const entry = registry.getConnection(connectionId);
      if (!entry || !table) return errorEnvelope(entry ? DB_ERROR_CODES.INVALID_PARAMS : DB_ERROR_CODES.NOT_CONNECTED, entry ? "table required" : "not connected");
      const updates = Array.isArray(changes.updates) ? changes.updates : [];
      const inserts = Array.isArray(changes.inserts) ? changes.inserts : [];
      const deletes = Array.isArray(changes.deletes) ? changes.deletes : [];
      const total = updates.length + inserts.length + deletes.length;
      if (total === 0) return okEnvelope({ applied: { updates: 0, inserts: 0, deletes: 0 } });
      if (total > MAX_PENDING_CHANGES) return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, `too many pending changes (${total} > ${MAX_PENDING_CHANGES})`);
      registry.touchConnection(connectionId);
      const tbl = `${schema ? q(schema) + "." : ""}${q(table)}`;
      const conn = entry.client.conn;
      try {
        await runWrite(conn, "START TRANSACTION");
        const applied = { updates: 0, inserts: 0, deletes: 0 };
        for (const u of updates) {
          if (!u.pk || !u.column || u.pkValue == null) throw new Error("invalid update entry");
          await runWrite(conn, `UPDATE ${tbl} SET ${q(u.column)} = ? WHERE ${q(u.pk)} = ?`, [u.value === null ? null : String(u.value), String(u.pkValue)]);
          applied.updates += 1;
        }
        for (const ins of inserts) {
          const cols = Object.keys(ins.values || {});
          if (cols.length === 0) continue;
          const sql = `INSERT INTO ${tbl} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
          await runWrite(conn, sql, cols.map((c) => (ins.values[c] === null ? null : String(ins.values[c]))));
          applied.inserts += 1;
        }
        for (const d of deletes) {
          if (!d.pk || d.pkValue == null) throw new Error("invalid delete entry");
          await runWrite(conn, `DELETE FROM ${tbl} WHERE ${q(d.pk)} = ?`, [String(d.pkValue)]);
          applied.deletes += 1;
        }
        await runWrite(conn, "COMMIT");
        return okEnvelope({ applied });
      } catch (err) {
        try { await runWrite(conn, "ROLLBACK"); } catch { /* connection may be broken; registry reaps it */ }
        return errorEnvelope(classifyDriverError(err), err?.message || "apply failed");
      }
    });

    ipcMain.handle(`quolldesk:${channel}:query`, async (_event, { connectionId, sql, timeoutMs } = {}) => {
      const entry = registry.getConnection(connectionId);
      if (!entry || !sql || !String(sql).trim()) {
        return errorEnvelope(entry ? DB_ERROR_CODES.INVALID_PARAMS : DB_ERROR_CODES.NOT_CONNECTED, entry ? "sql required" : "not connected");
      }
      registry.touchConnection(connectionId);
      const started = Date.now();
      try {
        const segments = await runQuery(entry.client.conn, String(sql), Math.min(Number(timeoutMs) || DEFAULT_QUERY_TIMEOUT_MS, 120_000));
        return okEnvelope({
          resultSets: segments.map((segment) => toResultSet(segment)),
          executionTimeMs: Date.now() - started,
          truncated: segments.some((segment) => segment.truncated),
        });
      } catch (err) {
        return errorEnvelope(classifyDriverError(err), err?.message || "query failed");
      }
    });

    // ---- Backup / restore (Wave 6) ----

    registerSqlDialogHandlers(ipcMain, `quolldesk:${channel}`);

    // Async dump job: the invoke returns { jobId } immediately; progress and
    // completion arrive on quolldesk:db:jobProgress. One job per connection.
    ipcMain.handle(`quolldesk:${channel}:backup`, async (event, { connectionId, scope = "database", table, includeData = true, outFile } = {}) => {
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
      void runMysqlFamilyBackup({
        event, conn: entry.client.conn, connectionId, jobId: job.jobId, scope, table, includeData, outFile,
      }).finally(job.release);
      return okEnvelope({ jobId: job.jobId });
    });

    // File restore: reads the SQL file, splits it with the shared quote/comment
    // aware splitter and executes statements sequentially. NOTE: DELIMITER-based
    // dumps (routines/procedures) are unsupported in v1 — a routine body's `;`
    // would split incorrectly. Already-executed statements stay applied on a
    // mid-file error (reported with its statement index via the error push).
    ipcMain.handle(`quolldesk:${channel}:restore`, async (event, { connectionId, inFile } = {}) => {
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
      const statements = splitSqlStatements(text, { backslashEscapes: true });
      registry.touchConnection(connectionId);
      void runSequentialRestore({
        event, jobId: job.jobId, dialect, statements,
        // affectedRows intentionally not counted/reported
        exec: (statement) => runWrite(entry.client.conn, statement),
      }).finally(job.release);
      return okEnvelope({ jobId: job.jobId });
    });
  }

  function closeAllForSender(senderId) { return registry.closeAllForSender(senderId); }

  return { registerHandlers, closeAllForSender, _setDriverForTests, _setDialogForTests, runQuery };
}

module.exports = { createMysqlFamilyBridge };
