"use strict";

/**
 * PostgreSQL Bridge - GUI client backend.
 * Channels: quolldesk:pg:{connect,disconnect,test,schemaTree,tableMeta,tableRows,query,applyTableChanges,
 *           pickBackupPath,pickRestoreFile,backup,restore}
 */

const { randomUUID } = require("node:crypto");
const fs = require("node:fs");

const registry = require("./dbCommon/connectionRegistry.cjs");
const { openDbTunnel } = require("./dbCommon/tunnel.cjs");
const {
  okEnvelope, errorEnvelope, DB_ERROR_CODES, classifyDriverError, serializeCellValue, buildTriggerMetas,
} = require("./dbCommon/resultEnvelope.cjs");
const {
  createDumpWriter, sqlLiteral, buildInsertStatements,
  splitSqlStatements, makeJobPusher, abortDump, runSequentialRestore,
} = require("./dbCommon/sqlDump.cjs");
const { buildGridWhere } = require("./dbCommon/gridWhere.cjs");
const { registerSqlDialogHandlers, _setDialogForTests } = require("./dbCommon/dialogHandlers.cjs");
const { reserveDbJob } = require("./dbCommon/dbJobs.cjs");
const { watchDriverDeath } = require("./dbCommon/closeNotifier.cjs");

const MAX_ROWS = 1000;
const MAX_PENDING_CHANGES = 500;
const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
const IDENT = /[^A-Za-z0-9_$]/g;
const q = (ident) => "\"" + String(ident).replace(IDENT, "\"\"") + "\"";

// pg and pg-query-stream are only needed once a PostgreSQL session actually
// dials; load them lazily so the app boot path never pays for the driver
// parse (a broken driver install then only breaks PG sessions, not the app).
let driver = null;
function getDriver() {
  if (driver === null) driver = require("pg");
  return driver;
}
let QueryStream;
function getQueryStream() {
  if (QueryStream === undefined) {
    try { QueryStream = require("pg-query-stream"); } catch { QueryStream = false; }
  }
  return QueryStream || null;
}
function _setDriverForTests(next) {
  driver = next ?? require("pg");
}

// ---- Backup / restore (Wave 6) ----
const DUMP_PAGE_SIZE = 500;     // rows per SELECT page
const DUMP_INSERT_BATCH = 100;  // rows per multi-row INSERT statement

// PK columns + constraint name of one table via information_schema
// (sequential like tableMeta). Backup uses the columns for ordering/keyset;
// tableMeta also reports the constraint name (designer DROP CONSTRAINT).
const PK_COLUMNS_SQL =
  "SELECT kcu.column_name, tc.constraint_name FROM information_schema.table_constraints tc " +
  "JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema " +
  "WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2 ORDER BY kcu.ordinal_position";

/**
 * One-round-trip schema listing shared by schemaTree and backup: every user
 * schema joined with its tables/views (LEFT JOIN keeps empty schemas). Replaces
 * the per-schema N+1 listing — on many-schema servers that was one query per
 * schema. relkind: 'r' table, 'p' partitioned table, 'v' view, 'm' matview.
 */
const SCHEMA_LISTING_SQL =
  "SELECT n.nspname AS schema_name, c.relname AS table_name, c.relkind AS kind " +
  "FROM pg_namespace n LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind IN ('r','p','v','m') " +
  "WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' " +
  "ORDER BY n.nspname, c.relname";

/**
 * Real index columns from pg_index/indkey (attname join, ordinal order) plus
 * the access method via pg_am (btree/hash/gin/gist/spgist/brin).
 * Expression-only indexes yield an empty column list. pg_indexes.indexdef
 * would need DDL parsing per consumer — column list and method belong to the
 * bridge.
 */
const INDEX_COLUMNS_SQL =
  "SELECT ic.relname AS indexname, am.amname AS method, idx.indisunique AS indisunique, " +
  "COALESCE((SELECT string_agg(att.attname, ',' ORDER BY k.ord) " +
  "FROM unnest(idx.indkey) WITH ORDINALITY AS k(attnum, ord) " +
  "JOIN pg_attribute att ON att.attrelid = idx.indrelid AND att.attnum = k.attnum), '') AS columns " +
  "FROM pg_class t " +
  "JOIN pg_namespace n ON n.oid = t.relnamespace " +
  "JOIN pg_index idx ON idx.indrelid = t.oid " +
  "JOIN pg_class ic ON ic.oid = idx.indexrelid " +
  "JOIN pg_am am ON am.oid = ic.relam " +
  "WHERE n.nspname = $1 AND t.relname = $2 ORDER BY ic.relname";

async function dial(event, opts) {
  let tunnel = null;
  if (opts.ssh) {
    // Unique per-attempt token: concurrent dials must not collide on the pool leaseId.
    tunnel = await openDbTunnel({
      event, ssh: opts.ssh, targetHost: opts.hostname, targetPort: opts.port, connectionId: randomUUID(),
    });
  }
  const config = opts.config || {};
  const client = new (getDriver().Client)({
    host: opts.hostname,
    port: opts.port,
    user: opts.username,
    password: opts.password,
    database: config.database || undefined,
    ...(tunnel ? { stream: tunnel.socket } : {}),
    ssl: config.tls ? { rejectUnauthorized: !config.tlsInsecure } : false,
    connectionTimeoutMillis: 10_000,
    statement_timeout: DEFAULT_QUERY_TIMEOUT_MS,
  });
  try {
    await client.connect();
    return { client, tunnel };
  } catch (err) {
    try { if (tunnel) tunnel.release(); } catch { /* ignore */ }
    throw err;
  }
}

function cellify(rows) {
  return (rows || []).map((row) =>
    Array.isArray(row) ? row : Object.keys(row).map((k) => serializeCellValue(row[k])));
}

async function runLimitedQuery(client, sql, values) {
  // Prefer a driver-supplied QueryStream (test fakes route on `stream.text` —
  // the real pg-query-stream keeps no .text); real pg has no QueryStream export,
  // so production always falls through to the pg-query-stream module.
  const streamClass = getDriver().QueryStream || getQueryStream();
  if (!streamClass) {
    const res = await client.query({ text: sql, values });
    return {
      rows: cellify(res.rows).slice(0, MAX_ROWS),
      columns: (res.fields || []).map((f) => ({ name: f.name })),
      truncated: res.rows.length > MAX_ROWS,
      rowCount: res.rowCount,
    };
  }
  // Real pg returns the stream itself from client.query(QueryStream); fakes or
  // downgrades return a plain result object (possibly wrapped in a promise) —
  // branch on the returned shape, then await resolves promise or plain value.
  const maybeStream = client.query(new streamClass(sql, values));
  if (typeof maybeStream?.on !== "function") {
    const res = (await maybeStream) || { rows: [], fields: [] };
    return {
      rows: cellify(res.rows || []).slice(0, MAX_ROWS),
      columns: (res.fields || []).map((f) => ({ name: f.name })),
      truncated: (res.rows || []).length > MAX_ROWS,
      rowCount: res.rowCount,
    };
  }
  return new Promise((resolve, reject) => {
    const stream = maybeStream;
    const rows = [];
    let truncated = false;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      // Rows can drain past the cap between destroy() and stream teardown —
      // slice here. Field names fall back to first-row objects (pg-query-stream
      // v4.17 exposes no header/field-description event), and the stream keeps
      // no row count, so DML affectedRows is unavailable on this path.
      resolve({
        rows: cellify(rows.slice(0, MAX_ROWS)),
        columns: rows[0] ? Object.keys(rows[0]).map((name) => ({ name })) : [],
        truncated,
        rowCount: undefined,
      });
    };
    stream.on("data", (row) => {
      if (rows.length < MAX_ROWS) rows.push(row);
      else { truncated = true; stream.destroy(); }
    });
    stream.on("error", reject);
    // pg-query-stream emits 'close' (not 'end') after destroy() on the row
    // cap; 'end' still fires for normal completion — finish exactly once.
    stream.on("end", finish);
    stream.on("close", finish);
  });
}

// values must be forwarded: without them pg uses the simple query protocol
// and any $1 placeholder fails with "there is no parameter $1".
//
// One pg client must not run concurrent queries (node-postgres pipelines them
// and request/response pairing can misorder under load — observed as hung
// tableMeta storms when the ER panel and the structure page queried at the
// same time). A per-client promise chain serializes everything that goes
// through this helper.
const fullQueryQueues = new WeakMap();

async function runFullQuery(client, sql, values) {
  const prev = fullQueryQueues.get(client) ?? Promise.resolve();
  const next = prev.then(() => client.query({ text: sql, values }));
  fullQueryQueues.set(client, next.catch(() => undefined));
  const res = await next;
  return { rows: res.rows || [], fields: res.fields || [] };
}

/**
 * Emit `CREATE [UNIQUE] INDEX IF NOT EXISTS ...` from a pg_indexes indexdef.
 * IF NOT EXISTS makes the dump idempotent: the PRIMARY KEY's backing index
 * already exists after the dump's ALTER TABLE ... ADD PRIMARY KEY, so a
 * plain re-execution of the indexdef would fail.
 */
function indexDefStatement(indexdef) {
  return String(indexdef)
    .replace(/^CREATE\s+UNIQUE\s+INDEX\s+/i, "CREATE UNIQUE INDEX IF NOT EXISTS ")
    .replace(/^CREATE\s+INDEX\s+/i, "CREATE INDEX IF NOT EXISTS ") + ";";
}

/**
 * Stream all user schemas' tables/views into a plain SQL dump file.
 * Never throws to the caller: every failure path pushes phase:'error' on
 * quolldesk:db:jobProgress and deletes the partial file. Pushes stop (and the
 * job aborts) as soon as the renderer that started the job is gone.
 * Known limitation (documented): foreign key constraints are NOT emitted —
 * the dump restores table/PK/index/view structure only.
 */
async function runPgBackup({ event, client, connectionId, jobId, scope, schema, table, includeData, outFile }) {
  const writer = createDumpWriter(outFile);
  const { senderAlive, push } = makeJobPusher(event, jobId, "postgresql");
  try {
    await writer.write(
      `-- QuollDesk SQL dump\n-- Dialect: postgresql\n-- Scope: ${scope === "table" ? `table ${schema}.${table}` : "database (all user schemas)"}\n` +
      `-- Generated: ${new Date().toISOString()}\n` +
      "-- Note: foreign key constraints are not emitted (limitation).\n\n",
    );

    // Same single-round-trip schema/table listing source as schemaTree.
    const schemaRows = (await runFullQuery(client, SCHEMA_LISTING_SQL)).rows;
    const dumpTables = [];
    const dumpViews = [];
    for (const row of schemaRows) {
      if (row.table_name == null) continue; // empty schema: no pg_class match
      const name = row.schema_name;
      if (scope === "table") {
        if (name === schema && row.table_name === table && (row.kind === "r" || row.kind === "p")) dumpTables.push({ schema: name, name: row.table_name });
      } else if (row.kind === "r" || row.kind === "p") {
        dumpTables.push({ schema: name, name: row.table_name });
      } else {
        dumpViews.push({ schema: name, name: row.table_name, materialized: row.kind === "m" });
      }
    }
    if (scope === "table" && dumpTables.length === 0) throw new Error(`table not found: ${schema}.${table}`);

    let tablesDone = 0;
    for (const entry of dumpTables) {
      if (!senderAlive()) throw new Error("renderer gone — backup aborted");
      registry.touchConnection(connectionId);
      const label = `${entry.schema}.${entry.name}`;
      const tbl = `${q(entry.schema)}.${q(entry.name)}`;
      await push({ phase: "tables", table: label, tablesDone, tablesTotal: dumpTables.length });
      await writer.write(`DROP TABLE IF EXISTS ${tbl} CASCADE;\n`);

      // CREATE TABLE reconstructed from information_schema.columns
      // (type / nullable / default); serial columns keep their nextval default.
      const cols = (await runFullQuery(client,
        "SELECT column_name, data_type, is_nullable, column_default AS default_value FROM information_schema.columns " +
        "WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position", [entry.schema, entry.name])).rows;
      if (cols.length === 0) throw new Error(`no columns found for ${label}`);
      const lines = cols.map((c) => {
        let line = `  ${q(c.column_name)} ${c.data_type}`;
        if (c.is_nullable === "NO") line += " NOT NULL";
        if (c.column_default != null && String(c.column_default).length > 0) line += ` DEFAULT ${c.column_default}`;
        return line;
      });
      await writer.write(`CREATE TABLE ${tbl} (\n${lines.join(",\n")}\n);\n`);

      // PK (unnamed ADD PRIMARY KEY — pg auto-names it, avoiding collisions).
      const pkCols = (await runFullQuery(client, PK_COLUMNS_SQL, [entry.schema, entry.name]))
        .rows.map((r) => r.column_name).filter(Boolean);
      if (pkCols.length > 0) {
        await writer.write(`ALTER TABLE ${tbl} ADD PRIMARY KEY (${pkCols.map(q).join(", ")});\n`);
      }
      await writer.write("\n");

      if (includeData) {
        const order = pkCols.length > 0 ? ` ORDER BY ${pkCols.map(q).join(", ")}` : "";
        // json/jsonb columns are cast to text server-side: the driver hands
        // back the exact stored document (scalar strings keep their quotes,
        // json null stays distinct from SQL NULL) and sqlLiteral's string path
        // emits a literal PG re-casts on restore. Fetching them as parsed JS
        // values would lose json scalars ('"hello"' → 'hello' → invalid json).
        const jsonCols = new Set(
          cols.filter((c) => /^(json|jsonb)$/.test(String(c.data_type))).map((c) => c.column_name),
        );
        const selectList = cols
          .map((c) => (jsonCols.has(c.column_name) ? `${q(c.column_name)}::text` : q(c.column_name)))
          .join(", ");
        // Keyset cursor: the last page's PK values. Resuming with
        // `(pk…) > ($1…)`: OFFSET re-scans+discards all prior rows per page.
        let lastPkValues = null;
        let rowsDone = 0;
        for (;;) {
          if (!senderAlive()) throw new Error("renderer gone — backup aborted");
          const keyset = pkCols.length > 0 && lastPkValues
            ? ` WHERE (${pkCols.map(q).join(", ")}) > (${lastPkValues.map((_, i) => `$${i + 1}`).join(", ")})`
            : "";
          // Data pages must use RAW driver rows — runLimitedQuery applies the
          // grid's 4KB cell truncation (serializeCellValue), which corrupts
          // dumps: jsonb docs longer than 4096 chars were chopped mid-string
          // (restore → "invalid input syntax for type json") and long text
          // columns silently lost data. runFullQuery returns rows untouched.
          const page = await runFullQuery(client,
            `SELECT ${selectList} FROM ${tbl}${keyset}${order} LIMIT ${DUMP_PAGE_SIZE}`,
            lastPkValues && lastPkValues.length ? lastPkValues : undefined);
          const rows = page.rows || [];
          if (rows.length > 0) {
            const columns = (page.fields || []).map((f) => f.name);
            // buildInsertStatements needs value arrays in column order (the
            // removed cellify path used to produce them implicitly); values
            // stay RAW for sqlLiteral — Dates/Buffers/objects render as-is.
            const valueRows = rows.map((row) => columns.map((name) => (row == null ? null : row[name])));
            const statements = buildInsertStatements({
              tableRef: tbl, quote: q, columns, rows: valueRows,
              literal: (v) => sqlLiteral(v, { escapeBackslash: false }),
              batchSize: DUMP_INSERT_BATCH,
            });
            for (const statement of statements) await writer.write(statement + "\n");
            if (pkCols.length > 0) {
              const lastRow = rows[rows.length - 1];
              lastPkValues = lastRow == null
                ? null
                : pkCols.map((name) => lastRow[columns.indexOf(name)]);
            }
          }
          rowsDone += rows.length;
          if (rows.length < DUMP_PAGE_SIZE) break;
          await push({ phase: "rows", table: label, rowsDone });
        }
        await push({ phase: "rows", table: label, rowsDone });
      }

      // Indexes AFTER data, idempotent via IF NOT EXISTS (see helper above).
      const indexes = (await runFullQuery(client,
        "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2", [entry.schema, entry.name])).rows;
      for (const idx of indexes) {
        if (idx.indexdef) await writer.write(indexDefStatement(idx.indexdef) + "\n");
      }
      // FK constraints after indexes (referenced tables exist by then). The
      // constraintdef carries the full FOREIGN KEY clause including actions.
      const fks = (await runFullQuery(client,
        "SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS def " +
        "FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid " +
        "JOIN pg_namespace n ON n.oid = rel.relnamespace " +
        "WHERE con.contype = 'f' AND n.nspname = $1 AND rel.relname = $2 ORDER BY con.conname",
        [entry.schema, entry.name])).rows;
      for (const fk of fks) {
        if (fk.name && fk.def) {
          await writer.write(`ALTER TABLE ${tbl} ADD CONSTRAINT ${q(fk.name)} ${fk.def};\n`);
        }
      }
      await writer.write("\n");
      // Triggers last (after data + FKs): INSERTs during restore stay un-fired.
      const triggers = (await runFullQuery(client,
        "SELECT tg.tgname AS name, pg_get_triggerdef(tg.oid) AS def FROM pg_trigger tg " +
        "JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE n.nspname = $1 AND c.relname = $2 AND NOT tg.tgisinternal ORDER BY tg.tgname",
        [entry.schema, entry.name])).rows;
      for (const trg of triggers) {
        if (trg.def) await writer.write(`${trg.def};\n`);
      }
      await writer.write("\n");
      tablesDone += 1;
    }

    // Views at the very end (plain views CASCADE-drop; matviews keep their
    // CREATE MATERIALIZED VIEW form). pg_get_viewdef returns the SELECT with
    // a trailing semicolon — strip it before re-wrapping.
    if (scope === "database" && dumpViews.length > 0) {
      await push({ phase: "views" });
      for (const view of dumpViews) {
        if (!senderAlive()) throw new Error("renderer gone — backup aborted");
        const vtbl = `${q(view.schema)}.${q(view.name)}`;
        const defRaw = (await runFullQuery(client,
          `SELECT pg_get_viewdef('${vtbl}'::regclass, true) AS def`)).rows[0]?.def;
        const def = String(defRaw || "").trim().replace(/;$/, "").trim();
        if (!def) throw new Error(`pg_get_viewdef failed for ${view.schema}.${view.name}`);
        await writer.write(
          (view.materialized ? `DROP MATERIALIZED VIEW IF EXISTS ${vtbl} CASCADE;\n` : `DROP VIEW IF EXISTS ${vtbl} CASCADE;\n`) +
          (view.materialized ? `CREATE MATERIALIZED VIEW ${vtbl} AS ${def};\n\n` : `CREATE VIEW ${vtbl} AS ${def};\n\n`),
        );
      }
    }

    // Routines last (database scope only): CREATE OR REPLACE FUNCTION defs are
    // self-contained and the restore splitter tolerates $$ bodies. Failure to
    // read them (permissions) skips the section rather than failing the dump.
    if (scope === "database") {
      try {
        const routines = (await runFullQuery(client,
          "SELECT p.proname AS name, pg_get_functiondef(p.oid) AS def FROM pg_proc p " +
          "JOIN pg_namespace n ON n.oid = p.pronamespace " +
          "WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prokind IN ('f', 'p') " +
          "ORDER BY p.proname")).rows;
        if (routines.length > 0) {
          await push({ phase: "routines" });
          for (const routine of routines) {
            if (!routine.def) continue;
            await writer.write(`${routine.def};\n`);
          }
        }
      } catch { /* routine dump is best-effort */ }
    }
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
  ipcMain.handle("quolldesk:pg:connect", async (event, opts = {}) => {
    if (!opts.hostname || !Number.isInteger(opts.port)) {
      return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, "hostname and integer port are required");
    }
    try {
      const { client, tunnel } = await dial(event, opts);
      const connectionId = registry.registerConnection({
        dialect: "postgresql",
        senderId: event.sender.id,
        client: { client },
        tunnel,
        meta: {
          hostname: opts.hostname,
          port: opts.port,
          database: opts.config?.database ?? null,
          username: opts.username ?? null,
        },
        close: () => {
          try { client.end(); } catch { /* ignore */ }
          if (tunnel) tunnel.release();
        },
      });
      watchDriverDeath(client, connectionId, registry);
      return okEnvelope({ connectionId });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "connect failed");
    }
  });

  ipcMain.handle("quolldesk:pg:disconnect", async (_event, { connectionId } = {}) => {
    if (!connectionId) return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, "connectionId required");
    registry.closeConnection(connectionId, "user");
    return okEnvelope({});
  });

  ipcMain.handle("quolldesk:pg:test", async (event, opts = {}) => {
    if (!opts.hostname || !Number.isInteger(opts.port)) {
      return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, "hostname and integer port are required");
    }
    let dialed = null;
    const started = Date.now();
    try {
      dialed = await dial(event, opts);
      const res = await dialed.client.query("SELECT version() AS v");
      return okEnvelope({
        latencyMs: Date.now() - started,
        serverVersion: String(res.rows[0]?.v || "unknown").split(" ").slice(0, 2).join(" "),
      });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "test failed");
    } finally {
      if (dialed) { try { await dialed.client.end(); } catch { /* ignore */ } try { dialed.tunnel?.release(); } catch { /* ignore */ } }
    }
  });

  ipcMain.handle("quolldesk:pg:schemaTree", async (_event, { connectionId } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry) return errorEnvelope(DB_ERROR_CODES.NOT_CONNECTED, "not connected");
    registry.touchConnection(connectionId);
    try {
      // Single round trip (see SCHEMA_LISTING_SQL): replaces the per-schema
      // N+1 listing.
      const rows = (await runFullQuery(entry.client.client, SCHEMA_LISTING_SQL)).rows;
      const databases = [];
      let current = null;
      for (const row of rows) {
        if (!current || current.name !== row.schema_name) {
          current = { name: row.schema_name, tables: [], views: [] };
          databases.push(current);
        }
        if (row.table_name == null) continue; // empty schema: no pg_class match
        if (row.kind === "r" || row.kind === "p") current.tables.push(row.table_name);
        else current.views.push(row.table_name);
      }
      return okEnvelope({ databases });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "schemaTree failed");
    }
  });

  ipcMain.handle("quolldesk:pg:tableMeta", async (_event, { connectionId, table, schema = "public" } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry || !table) return errorEnvelope(entry ? DB_ERROR_CODES.INVALID_PARAMS : DB_ERROR_CODES.NOT_CONNECTED, entry ? "table required" : "not connected");
    registry.touchConnection(connectionId);
    try {
      // Sequential on purpose: pg deprecates concurrent queries on one client.
      // col_description via to_regclass(%I.%I) survives odd identifiers and
      // yields null for comment-less columns (ER panel surfaces it raw).
      const columns = await runFullQuery(entry.client.client,
        "SELECT column_name, data_type, is_nullable, column_default AS default_value, " +
        "col_description(to_regclass(format('%I.%I', table_schema, table_name)), ordinal_position) AS comment " +
        "FROM information_schema.columns " +
        "WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position", [schema, table]);
      // PK (columns flagged 'PRI' + constraint name) so the renderer never has
      // to parse DDL to answer "which column is the primary key".
      const pkRows = (await runFullQuery(entry.client.client, PK_COLUMNS_SQL, [schema, table])).rows;
      const pkCols = pkRows.map((r) => r.column_name).filter(Boolean);
      const pkSet = new Set(pkCols);
      const indexes = await runFullQuery(entry.client.client, INDEX_COLUMNS_SQL, [schema, table]);
      const estimate = await runFullQuery(entry.client.client,
        "SELECT reltuples::text AS estimate, c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE n.nspname = $1 AND c.relname = $2", [schema, table]);
      // FK metadata via pg_constraint (structural): composite ordered column
      // lists through conkey/confkey unnest joins, plus the canonical ON
      // DELETE / ON UPDATE actions (confdeltype/confupdtype codes).
      const foreignKeys = await runFullQuery(entry.client.client,
        "SELECT con.conname AS name, " +
        "(SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) " +
        "JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns, " +
        "rt.relname AS ref_table, rtn.nspname AS ref_schema, " +
        "(SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord) " +
        "JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS ref_columns, " +
        "CASE con.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS on_delete, " +
        "CASE con.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS on_update " +
        "FROM pg_constraint con " +
        "JOIN pg_class rel ON rel.oid = con.conrelid " +
        "JOIN pg_namespace n ON n.oid = rel.relnamespace " +
        "JOIN pg_class rt ON rt.oid = con.confrelid " +
        "JOIN pg_namespace rtn ON rtn.oid = rt.relnamespace " +
        "WHERE con.contype = 'f' AND n.nspname = $1 AND rel.relname = $2 ORDER BY con.conname", [schema, table]);
      // Views (plain 'v' and materialized 'm') carry their source as the
      // definition; the regclass text is built with q() quoting, so the only
      // characters inside the single-quoted literal are double quotes and
      // identifiers — a single quote cannot appear. Tables keep ddl: null
      // (their index definitions are already returned above).
      // Table-level triggers (read-only v1): information_schema.triggers is
      // the cross-engine common denominator.
      const triggers = buildTriggerMetas((await runFullQuery(entry.client.client,
        "SELECT trigger_name AS name, action_timing AS timing, event_manipulation AS event, action_statement AS statement " +
        "FROM information_schema.triggers WHERE trigger_schema = $1 AND event_object_table = $2 ORDER BY trigger_name",
        [schema, table])).rows);
      const kind = estimate.rows[0]?.kind;
      let ddl = null;
      if (kind === "v" || kind === "m") {
        const def = await runFullQuery(entry.client.client,
          `SELECT pg_get_viewdef('${q(schema)}.${q(table)}'::regclass, true) AS def`);
        ddl = def.rows[0]?.def || null;
      }
      return okEnvelope({
        columns: columns.rows.map((c) => ({
          name: c.column_name, type: c.data_type, nullable: c.is_nullable === "YES", defaultValue: c.default_value,
          key: pkSet.has(c.column_name) ? "PRI" : null,
          comment: c.comment || null,
        })),
        indexes: indexes.rows.map((r) => ({
          name: r.indexname,
          columns: String(r.columns || "").split(",").map((s) => s.trim()).filter(Boolean),
          unique: r.indisunique === true,
          method: String(r.method || "") || null,
        })),
        primaryKey: pkCols.length > 0
          ? { name: pkRows[0]?.constraint_name || null, columns: pkCols }
          : null,
        foreignKeys: foreignKeys.rows.map((r) => ({
          name: r.name,
          columns: r.columns,
          refTable: r.ref_table,
          refSchema: r.ref_schema,
          refColumns: r.ref_columns,
          onDelete: r.on_delete,
          onUpdate: r.on_update,
        })),
        ddl,
        triggers,
        rowCountEstimate: Math.max(0, Number(estimate.rows[0]?.estimate ?? 0)),
      });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "tableMeta failed");
    }
  });

  ipcMain.handle("quolldesk:pg:tableRows", async (_event, { connectionId, table, schema = "public", orderBy, orderDir, filters, offset = 0, limit = 100 } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry || !table) return errorEnvelope(entry ? DB_ERROR_CODES.INVALID_PARAMS : DB_ERROR_CODES.NOT_CONNECTED, entry ? "table required" : "not connected");
    registry.touchConnection(connectionId);
    const pageLimit = Math.min(Math.max(1, Number(limit) || 100), MAX_ROWS);
    const tbl = `${q(schema)}.${q(table)}`;
    const dir = orderDir === "asc" ? " ASC" : orderDir === "desc" ? " DESC" : "";
    const order = orderBy ? ` ORDER BY ${q(orderBy)}${dir}` : "";
    const { where, values } = buildGridWhere(filters, { quote: q, placeholder: (i) => `$${i}` });
    try {
      const partial = await runLimitedQuery(entry.client.client,
        `SELECT * FROM ${tbl}${where}${order} LIMIT ${pageLimit} OFFSET ${Math.max(0, Number(offset) || 0)}`,
        values.length ? values : undefined);
      return okEnvelope({ columns: partial.columns, rows: partial.rows, truncated: partial.truncated });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "tableRows failed");
    }
  });

  // Apply pending grid edits transactionally (BEGIN ... COMMIT / ROLLBACK).
  ipcMain.handle("quolldesk:pg:applyTableChanges", async (_event, { connectionId, table, schema = "public", changes = {} } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry || !table) return errorEnvelope(entry ? DB_ERROR_CODES.INVALID_PARAMS : DB_ERROR_CODES.NOT_CONNECTED, entry ? "table required" : "not connected");
    const updates = Array.isArray(changes.updates) ? changes.updates : [];
    const inserts = Array.isArray(changes.inserts) ? changes.inserts : [];
    const deletes = Array.isArray(changes.deletes) ? changes.deletes : [];
    const total = updates.length + inserts.length + deletes.length;
    if (total === 0) return okEnvelope({ applied: { updates: 0, inserts: 0, deletes: 0 } });
    if (total > MAX_PENDING_CHANGES) return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, `too many pending changes (${total} > ${MAX_PENDING_CHANGES})`);
    registry.touchConnection(connectionId);
    const tbl = `${q(schema)}.${q(table)}`;
    const client = entry.client.client;
    try {
      await client.query("BEGIN");
      const applied = { updates: 0, inserts: 0, deletes: 0 };
      for (const u of updates) {
        if (!u.pk || !u.column || u.pkValue == null) throw new Error("invalid update entry");
        await client.query(`UPDATE ${tbl} SET ${q(u.column)} = $1 WHERE ${q(u.pk)} = $2`, [u.value === null ? null : String(u.value), String(u.pkValue)]);
        applied.updates += 1;
      }
      for (const ins of inserts) {
        const cols = Object.keys(ins.values || {});
        if (cols.length === 0) continue;
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
        const sql = `INSERT INTO ${tbl} (${cols.map(q).join(", ")}) VALUES (${placeholders})`;
        await client.query(sql, cols.map((c) => (ins.values[c] === null ? null : String(ins.values[c]))));
        applied.inserts += 1;
      }
      for (const d of deletes) {
        if (!d.pk || d.pkValue == null) throw new Error("invalid delete entry");
        await client.query(`DELETE FROM ${tbl} WHERE ${q(d.pk)} = $1`, [String(d.pkValue)]);
        applied.deletes += 1;
      }
      await client.query("COMMIT");
      return okEnvelope({ applied });
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* connection may be broken; registry reaps it */ }
      return errorEnvelope(classifyDriverError(err), err?.message || "apply failed");
    }
  });

  ipcMain.handle("quolldesk:pg:query", async (_event, { connectionId, sql, values } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry || !sql || !String(sql).trim()) {
      return errorEnvelope(entry ? DB_ERROR_CODES.INVALID_PARAMS : DB_ERROR_CODES.NOT_CONNECTED, entry ? "sql required" : "not connected");
    }
    registry.touchConnection(connectionId);
    const started = Date.now();
    const text = String(sql);
    try {
      // Single statement (no ";"): route through runLimitedQuery, which streams
      // and destroys past MAX_ROWS — a plain `SELECT * FROM big_table` would
      // otherwise buffer every row in the main process before the slice below
      // could cap it (OOM risk). Misclassification is safe in both directions:
      // a quoted ";" keeps the uncapped path (still correct, just not capped),
      // and a trailing ";" keeps multi-statement handling.
      if (!text.includes(";")) {
        const limited = await runLimitedQuery(entry.client.client, text, values);
        return okEnvelope({
          resultSets: [{
            columns: limited.columns,
            rows: limited.rows,
            affectedRows: limited.rowCount != null && !limited.columns.length ? limited.rowCount : undefined,
          }],
          executionTimeMs: Date.now() - started,
          truncated: limited.truncated,
        });
      }
      // Multi-statement scripts need pg's simple query protocol: with no
      // values it resolves an ARRAY of per-statement results; pg reports only
      // the last statement's outcome — return that honestly instead of an
      // empty result set. Scripts are capped by post-slicing only (accepted
      // cost: scripts are bounded by statement_timeout and editor use).
      let res = await entry.client.client.query({ text, values });
      if (Array.isArray(res)) res = res[res.length - 1];
      const fieldNames = (res.fields || []).map((f) => ({ name: f.name }));
      const rows = res.rows || [];
      return okEnvelope({
        resultSets: [{
          columns: fieldNames,
          rows: cellify(rows).slice(0, MAX_ROWS),
          affectedRows: res.rowCount != null && !fieldNames.length ? res.rowCount : undefined,
        }],
        executionTimeMs: Date.now() - started,
        truncated: rows.length > MAX_ROWS,
      });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "query failed");
    }
  });

  // ---- Backup / restore (Wave 6) ----

  // Session manager: live sessions of the connected database (excluding our
  // own backend) + terminate / cancel. mssql/sqlite semantics differ and live
  // in their bridges; sqlite has no server sessions at all.
  ipcMain.handle("quolldesk:pg:sessions", async (_event, { connectionId } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry) return errorEnvelope(DB_ERROR_CODES.NOT_CONNECTED, "not connected");
    registry.touchConnection(connectionId);
    try {
      const res = await runFullQuery(entry.client.client,
        "SELECT pid, usename AS user, application_name AS app, state, " +
        "COALESCE(ROUND(EXTRACT(EPOCH FROM (now() - backend_start)))::text, '') AS seconds, " +
        "COALESCE(left(query, 500), '') AS query " +
        "FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() ORDER BY backend_start");
      const sessions = res.rows.map((r) => ({
        id: String(r.pid), user: String(r.user || ''), app: String(r.app || ''),
        state: String(r.state || ''), seconds: Number(r.seconds || 0), query: String(r.query || ''),
      }));
      return okEnvelope({ sessions });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "sessions failed");
    }
  });

  ipcMain.handle("quolldesk:pg:killSession", async (_event, { connectionId, pid, cancel } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry || !pid) return errorEnvelope(entry ? DB_ERROR_CODES.INVALID_PARAMS : DB_ERROR_CODES.NOT_CONNECTED, entry ? "pid required" : "not connected");
    registry.touchConnection(connectionId);
    try {
      const fn = cancel ? "pg_cancel_backend" : "pg_terminate_backend";
      const res = await runFullQuery(entry.client.client, `SELECT ${fn}($1::int) AS ok`, [Number(pid)]);
      const done = res.rows[0]?.ok === true;
      return done ? okEnvelope({}) : errorEnvelope(DB_ERROR_CODES.QUERY_ERROR, "session not found or already gone");
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "kill failed");
    }
  });

  registerSqlDialogHandlers(ipcMain, "quolldesk:pg");

  // Async dump job: the invoke returns { jobId } immediately; progress and
  // completion arrive on quolldesk:db:jobProgress. One job per connection.
  // `schema` only applies to table scope (default 'public').
  ipcMain.handle("quolldesk:pg:backup", async (event, { connectionId, scope = "database", schema = "public", table, includeData = true, outFile } = {}) => {
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
    void runPgBackup({
      event, client: entry.client.client, connectionId, jobId: job.jobId, scope, schema, table, includeData, outFile,
    }).finally(job.release);
    return okEnvelope({ jobId: job.jobId });
  });

  // File restore: reads the SQL file, splits it with the shared quote/comment
  // aware splitter and executes statements sequentially. NOTE: DELIMITER-based
  // dumps (routines/procedures) are unsupported in v1 — a routine body's `;`
  // would split incorrectly. Already-executed statements stay applied on a
  // mid-file error (reported with its statement index via the error push).
  ipcMain.handle("quolldesk:pg:restore", async (event, { connectionId, inFile } = {}) => {
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
    const statements = splitSqlStatements(text, { backslashEscapes: false });
    registry.touchConnection(connectionId);
    void runSequentialRestore({
      event, jobId: job.jobId, dialect: "postgresql", statements,
      exec: (statement) => entry.client.client.query(statement),
    }).finally(job.release);
    return okEnvelope({ jobId: job.jobId });
  });
}

function closeAllForSender(senderId) { return registry.closeAllForSender(senderId); }

module.exports = { registerHandlers, closeAllForSender, _setDriverForTests, _setDialogForTests, runLimitedQuery, runFullQuery };
