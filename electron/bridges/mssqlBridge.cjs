"use strict";

/**
 * SQL Server Bridge - GUI client backend.
 * Channels: quolldesk:mssql:{connect,disconnect,test,schemaTree,tableMeta,tableRows,query,
 *           applyTableChanges,pickBackupPath,pickRestoreFile,backup,restore}
 * Driver: mssql (tedious, pure JS — no native addons). SQL authentication only
 * (macOS/Linux clients cannot use Windows integrated auth).
 * No SSH tunnel in v1: the mssql package's public config exposes no
 * custom-socket hook for tedious connections.
 * API notes verified against node_modules/mssql 12.x source:
 * - per-request timeout is `pool.request({ requestTimeout: ms })` / pool-level
 *   `options.requestTimeout` — there is NO `request.timeout` property in v12;
 * - the connect option is `options.connectTimeout` (no connectTimeoutMilliseconds).
 */

const fs = require("node:fs");

const registry = require("./dbCommon/connectionRegistry.cjs");
const {
  okEnvelope, errorEnvelope, DB_ERROR_CODES, classifyDriverError, serializeCellValue, buildTriggerMetas,
} = require("./dbCommon/resultEnvelope.cjs");
const {
  createDumpWriter, sqlLiteral, buildInsertStatements,
  makeJobPusher, abortDump, runSequentialRestore,
} = require("./dbCommon/sqlDump.cjs");
// Task 2's dialect-aware splitter: `splitSqlStatements(sql, "mssql")` handles
// [bracket identifiers] and reads backslashes literally. GO batch separators
// are NOT split in v1 (documented limitation — a dump using GO would fail on
// restore with a driver syntax error naming the statement).
const { splitSqlStatements } = require("./dbCommon/readOnlySql.cjs");
const { buildGridWhere } = require("./dbCommon/gridWhere.cjs");
const { registerSqlDialogHandlers, _setDialogForTests } = require("./dbCommon/dialogHandlers.cjs");
const { reserveDbJob } = require("./dbCommon/dbJobs.cjs");
const { watchDriverDeath } = require("./dbCommon/closeNotifier.cjs");

const MAX_ROWS = 1000;
const MAX_PENDING_CHANGES = 500;
const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
const MAX_QUERY_TIMEOUT_MS = 120_000;

// ---- Backup / restore ----
const DUMP_PAGE_SIZE = 500;     // rows per SELECT page
const DUMP_INSERT_BATCH = 100;  // rows per multi-row INSERT statement

// mssql is only needed once a SQL Server session actually dials; load it
// lazily so the app boot path never pays for the driver parse (a broken
// driver install then only breaks MSSQL sessions, not the whole app).
let driver = null;
function getDriver() {
  if (driver === null) driver = require("mssql");
  return driver;
}
function _setDriverForTests(next) { driver = next ?? require("mssql"); }

// mssql bracket quoting: [ident] with doubled inner `]`.
const q = (ident) => "[" + String(ident).replace(/]/g, "]]") + "]";

/**
 * mssql INSERT literal adapter for buildInsertStatements: tedious returns BIT
 * as true/false and varbinary as Buffer — bare sqlLiteral would render
 * TRUE/FALSE and '\x…'::bytea (pg-only syntax), neither valid T-SQL.
 * Booleans become 1/0 and Buffers bare 0x<hex> binary literals; everything
 * else falls through to sqlLiteral (no backslash escaping — mssql reads `\`
 * literally, same default the dumps already relied on).
 */
function mssqlLiteral(value) {
  if (value === true) return "1";
  if (value === false) return "0";
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return `0x${value.toString("hex").toUpperCase()}`;
  }
  return sqlLiteral(value);
}

/**
 * Bracket-qualified object reference interpolated into a T-SQL N'…' string
 * literal (OBJECT_ID guards): q() doubles `]` for the bracket form, but a `'`
 * inside the object name would terminate the literal — double it per T-SQL
 * string rules (q's bracket doubling alone is not enough).
 */
function nLiteral(qualifiedRef) {
  return String(qualifiedRef).replace(/'/g, "''");
}

/**
 * Keyset predicate for N PK columns. T-SQL has no row-value comparison
 * (`WHERE ([a],[b]) > (x,y)` is invalid), so build the left-to-right OR-chain
 * `([a] > x1 OR ([a] = x1 AND [b] > x2))`. pkCols order is the single source
 * shared with the data-page ORDER BY (both come from the PK query rows).
 */
function keysetPredicate(pkCols, lastPkValues) {
  const parts = [];
  for (let i = 0; i < pkCols.length; i += 1) {
    const equals = [];
    for (let j = 0; j < i; j += 1) equals.push(`${q(pkCols[j])} = ${mssqlLiteral(lastPkValues[j])}`);
    // Wrap every AND-group so the OR-chain stays unambiguous regardless of
    // operator precedence: ([a] > x OR ([a] = x AND [b] > y)).
    parts.push(
      equals.length
        ? `(${equals.join(" AND ")} AND ${q(pkCols[i])} > ${mssqlLiteral(lastPkValues[i])})`
        : `${q(pkCols[i])} > ${mssqlLiteral(lastPkValues[i])}`,
    );
  }
  return ` WHERE (${parts.join(" OR ")})`;
}

/**
 * connectPool config mapping (mssql ConnectionPool):
 * - encrypt defaults ON (cloud SQL Server requires TLS) unless tls === false;
 * - tlsInsecure skips the server certificate check (trustServerCertificate).
 */
function connectPool(opts) {
  const config = opts.config || {};
  const pool = new (getDriver()).ConnectionPool({
    server: opts.hostname,
    port: opts.port,
    user: opts.username,
    password: opts.password,
    database: config.database || undefined,
    options: {
      encrypt: config.tls !== false,
      trustServerCertificate: config.tlsInsecure === true,
      connectTimeout: 10_000,
      requestTimeout: DEFAULT_QUERY_TIMEOUT_MS,
    },
  });
  return pool.connect().then(() => pool);
}

// ---- Metadata SQL (single statements, @named parameters via req.input) ----

const EXCLUDED_SCHEMAS = [
  "guest", "INFORMATION_SCHEMA", "sys", "db_owner", "db_accessadmin", "db_securityadmin",
  "db_ddladmin", "db_backupoperator", "db_datareader", "db_datawriter",
  "db_denydatareader", "db_denydatawriter",
];

/**
 * One-round-trip schema listing shared by schemaTree and backup: every user
 * schema joined with its tables/views (LEFT JOIN keeps empty schemas).
 * kind: 'U' table, 'V' view.
 */
const SCHEMA_LISTING_SQL =
  "SELECT s.name AS schema_name, o.name AS table_name, o.type AS kind " +
  "FROM sys.schemas s " +
  "LEFT JOIN sys.objects o ON o.schema_id = s.schema_id AND o.type IN ('U','V') " +
  `WHERE s.name NOT IN (${EXCLUDED_SCHEMAS.map((name) => `'${name}'`).join(", ")}) ` +
  "ORDER BY s.name, o.name";

// INFORMATION_SCHEMA cannot parameterize its schema qualifier when the caller
// omits one — fall back to the session's default schema via SCHEMA_NAME().
const COLUMNS_SQL_SCHEMA =
  "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT, CAST(ep.value AS NVARCHAR(4000)) AS COLUMN_COMMENT " +
  "FROM INFORMATION_SCHEMA.COLUMNS c " +
  "OUTER APPLY fn_listextendedproperty('MS_Description', 'SCHEMA', c.TABLE_SCHEMA, 'TABLE', c.TABLE_NAME, 'COLUMN', c.COLUMN_NAME) ep " +
  "WHERE c.TABLE_SCHEMA = @s AND c.TABLE_NAME = @t ORDER BY c.ORDINAL_POSITION";
const COLUMNS_SQL_CURRENT =
  "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT, CAST(ep.value AS NVARCHAR(4000)) AS COLUMN_COMMENT " +
  "FROM INFORMATION_SCHEMA.COLUMNS c " +
  "OUTER APPLY fn_listextendedproperty('MS_Description', 'SCHEMA', c.TABLE_SCHEMA, 'TABLE', c.TABLE_NAME, 'COLUMN', c.COLUMN_NAME) ep " +
  "WHERE c.TABLE_SCHEMA = SCHEMA_NAME() AND c.TABLE_NAME = @t ORDER BY c.ORDINAL_POSITION";

const PK_SQL_SCHEMA =
  "SELECT tc.CONSTRAINT_NAME AS constraint_name, ccu.COLUMN_NAME AS column_name " +
  "FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc " +
  "JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE ccu ON ccu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME " +
  "WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_SCHEMA = @s AND tc.TABLE_NAME = @t " +
  "ORDER BY ccu.COLUMN_NAME";
const PK_SQL_CURRENT =
  "SELECT tc.CONSTRAINT_NAME AS constraint_name, ccu.COLUMN_NAME AS column_name " +
  "FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc " +
  "JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE ccu ON ccu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME " +
  "WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_SCHEMA = SCHEMA_NAME() AND tc.TABLE_NAME = @t " +
  "ORDER BY ccu.COLUMN_NAME";

const INDEXES_SQL =
  "SELECT i.name, i.is_unique, i.is_primary_key, i.type_desc, c.name AS column_name, ic.key_ordinal " +
  "FROM sys.indexes i " +
  "JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id " +
  "JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id " +
  "WHERE i.object_id = OBJECT_ID(@qualified) ORDER BY i.name, ic.key_ordinal";

const DDL_SQL =
  "SELECT definition FROM sys.sql_modules WHERE object_id = OBJECT_ID(@qualified)";

const ROW_COUNT_SQL =
  "SELECT SUM(p.rows) AS c FROM sys.partitions p " +
  "WHERE p.object_id = OBJECT_ID(@qualified) AND p.index_id IN (0,1)";

const FK_SQL =
  "SELECT fk.name, pc.name AS column_name, rc.name AS ref_column, rt.name AS ref_table, rs.name AS ref_schema, " +
  "fkc.constraint_column_id, " +
  "CASE fk.delete_referential_action WHEN 1 THEN 'CASCADE' WHEN 2 THEN 'SET NULL' WHEN 3 THEN 'SET DEFAULT' ELSE 'NO ACTION' END AS on_delete, " +
  "CASE fk.update_referential_action WHEN 1 THEN 'CASCADE' WHEN 2 THEN 'SET NULL' WHEN 3 THEN 'SET DEFAULT' ELSE 'NO ACTION' END AS on_update " +
  "FROM sys.foreign_keys fk " +
  "JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id " +
  "JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id " +
  "JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id " +
  "JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id " +
  "JOIN sys.schemas rs ON rs.schema_id = rt.schema_id " +
  "WHERE fk.parent_object_id = OBJECT_ID(@qualified) " +
  "ORDER BY fk.name, fkc.constraint_column_id";

const TRIGGERS_SQL =
  "SELECT tr.name, " +
  "CASE WHEN tr.is_instead_of_trigger = 1 THEN 'INSTEAD OF' ELSE 'AFTER' END AS timing, " +
  "STUFF((SELECT ', ' + te.type_desc FROM sys.trigger_events te WHERE te.object_id = tr.object_id ORDER BY te.type_desc FOR XML PATH('')), 1, 2, '') AS event, " +
  "sm.definition AS statement " +
  "FROM sys.triggers tr " +
  "JOIN sys.sql_modules sm ON sm.object_id = tr.object_id " +
  "WHERE tr.parent_id = OBJECT_ID(@qualified) " +
  "ORDER BY tr.name";

// Trigger rows group into the canonical read-only shape via the shared
// dbCommon mapper (same contract as the mysql family and pg paths).

/**
 * Run one metadata query with @s/@t/@qualified named inputs (only the ones
 * given). Resolves to the first recordset (row objects) — [] when absent.
 */
async function runMeta(pool, sql, { s, t, qualified } = {}) {
  const req = pool.request();
  if (s !== undefined) req.input("s", s);
  if (t !== undefined) req.input("t", t);
  if (qualified !== undefined) req.input("qualified", qualified);
  const res = await req.query(sql);
  return (res.recordsets && res.recordsets[0]) || [];
}

/**
 * Shared recordset → grid core: columns come from the first row's keys
 * (non-stream tedious exposes no column descriptions), rows are capped and
 * cellified with serializeCellValue (tedious Dates/Buffers → JSON-safe).
 * rowShape 'array' zips cells against columns (grid rows); 'object' keeps
 * named cells (mysql-family batch segments).
 */
function cellifyRecordset(recordset, maxRows = MAX_ROWS, rowShape = "array") {
  const rows = Array.isArray(recordset) ? recordset : [];
  const columns = (rows[0] ? Object.keys(rows[0]) : []).map((name) => ({ name }));
  const cap = Math.max(1, Number(maxRows) || MAX_ROWS);
  const cellRows = rows.slice(0, cap).map((row) =>
    rowShape === "object"
      ? Object.fromEntries(columns.map((c) => [c.name, serializeCellValue(row?.[c.name])]))
      : columns.map((c) => serializeCellValue(row[c.name])));
  return { columns, rows: cellRows, truncated: rows.length > cellRows.length };
}

/**
 * One mssql recordset (row objects) → grid result set: columns + cellified
 * value arrays, capped at MAX_ROWS.
 */
function toResultSet(recordset) {
  return { ...cellifyRecordset(recordset, MAX_ROWS), affectedRows: undefined };
}

/**
 * databaseService (AI/MCP) consumes this: run one statement, truncate rows.
 * Returns `{ rows, columns, truncated, rowCount }` (rows cellified arrays
 * zipped against columns — the service normalizes them to objects).
 */
async function runLimitedQuery(pool, sql, maxRows = 200) {
  const res = await pool.request().query(String(sql));
  const recordset = (res.recordsets && res.recordsets[0]) || [];
  const { columns, rows, truncated } = cellifyRecordset(recordset, maxRows);
  return { rows, columns, truncated, rowCount: recordset.length };
}

/**
 * Map one mssql batch result (`{ recordsets, rowsAffected }`) into
 * mysql-family shaped segments — `{ columns, rows, okPacket, truncated }[]` —
 * shared by runQuery (plain pool batch) and runReadOnlyBatch
 * (Transaction-bound read batch) so the service maps mssql exactly like the
 * mysql path. Rows are cellified OBJECT rows; the flattened rowsAffected
 * aggregate attaches to the last column-less result set (or a synthetic
 * trailing set for a pure-DML batch), same semantics as the
 * quolldesk:mssql:query channel.
 */
function mapBatchResult(res) {
  const recordsets = Array.isArray(res.recordsets) ? res.recordsets : [];
  const affectedTotal = (res.rowsAffected || []).reduce((sum, n) => sum + (Number(n) || 0), 0);
  const segments = recordsets.map((recordset) => ({
    ...cellifyRecordset(recordset, MAX_ROWS, "object"),
    okPacket: null,
  }));
  let target = null;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (!segments[i].columns.length) { target = segments[i]; break; }
  }
  if (target) target.okPacket = { affectedRows: affectedTotal };
  else if (recordsets.length === 0) {
    segments.push({ columns: [], rows: [], okPacket: { affectedRows: affectedTotal }, truncated: false });
  }
  return segments;
}

/**
 * databaseService (AI/MCP) database.query/execute consume this: run one batch
 * on the pool and return mysql-family shaped segments —
 * `{ columns, rows, okPacket, truncated }[]` — so the service maps mssql
 * exactly like the mysql path.
 */
async function runQuery(pool, sql, timeoutMs) {
  // v12 exposes no request.timeout property — per-request timeout is a
  // Request override: pool.request({ requestTimeout }).
  const req = pool.request({
    requestTimeout: Math.min(Math.max(1, Number(timeoutMs) || DEFAULT_QUERY_TIMEOUT_MS), MAX_QUERY_TIMEOUT_MS),
  });
  const res = await req.query(String(sql));
  return mapBatchResult(res);
}

/**
 * databaseService (AI/MCP) database.query READ path for mssql: run one batch
 * inside a tedious Transaction bound to THIS pool. mssql's ConnectionPool
 * (min:0/max:10) hands every pool.request() an arbitrary idle connection, so
 * issuing BEGIN/query/ROLLBACK as three separate pool requests can scatter
 * them across connections — the batch would run OUTSIDE the transaction
 * (SELECT ... INTO would persist) and the ROLLBACK would leak a transaction
 * on another connection. Transaction.begin() acquires and holds ONE
 * connection, and every Request created against the transaction runs on it
 * (same pattern as the applyTableChanges handler). Never commits: rollback
 * runs in finally on success AND failure — the keyword gate is the primary
 * write block (mssql has no server-side READ ONLY transaction), the rollback
 * is the backstop.
 */
async function runReadOnlyBatch(pool, sql, timeoutMs) {
  const tx = new (getDriver()).Transaction(pool);
  await tx.begin();
  try {
    const req = new (getDriver()).Request(tx, {
      requestTimeout: Math.min(Math.max(1, Number(timeoutMs) || DEFAULT_QUERY_TIMEOUT_MS), MAX_QUERY_TIMEOUT_MS),
    });
    const res = await req.query(String(sql));
    return mapBatchResult(res);
  } finally {
    try { await tx.rollback(); } catch { /* connection may be broken; registry reaps it */ }
  }
}

/**
 * Stream one connection's tables/views into a plain SQL dump file.
 * Never throws to the caller: every failure path pushes phase:'error' on
 * quolldesk:db:jobProgress and deletes the partial file. Pushes stop (and the
 * job aborts) as soon as the renderer that started the job is gone.
 * DDL comes from sys.sql_modules.definition (CREATE TABLE/VIEW [s].[t] ...);
 * the dump drop-guards each object via OBJECT_ID. Data pages page by PK keyset
 * (per-column OR-chain predicate, keysetPredicate — OFFSET 0) with
 * ORDER BY (SELECT NULL) +
 * OFFSET/FETCH as the no-PK fallback. Views are emitted AFTER all tables so
 * their base tables exist at CREATE VIEW time. Foreign keys are NOT emitted
 * (documented limitation, same as the pg dump).
 */
async function runMssqlBackup({ event, pool, connectionId, jobId, scope, schema, table, includeData, outFile }) {
  const writer = createDumpWriter(outFile);
  const { senderAlive, push } = makeJobPusher(event, jobId, "mssql");
  try {
    await writer.write(
      `-- QuollDesk SQL dump\n-- Dialect: mssql\n-- Scope: ${scope === "table" ? `table ${schema}.${table}` : "database (all user schemas)"}\n` +
      `-- Generated: ${new Date().toISOString()}\n` +
      "-- Note: foreign key constraints are not emitted; GO batch separators are not supported in v1.\n\n",
    );

    // Same listing source as schemaTree: tables ('U') carry the data dump;
    // views ('V') are collected for the trailing definitions block.
    const listed = await runMeta(pool, SCHEMA_LISTING_SQL);
    const dumpTables = [];
    const dumpViews = [];
    for (const row of listed) {
      if (row.table_name == null) continue; // empty schema: no sys.objects match
      if (scope === "table") {
        if (row.kind === "U" && row.schema_name === schema && row.table_name === table) {
          dumpTables.push({ schema: row.schema_name, name: row.table_name });
        }
      } else if (row.kind === "U") {
        dumpTables.push({ schema: row.schema_name, name: row.table_name });
      } else {
        dumpViews.push({ schema: row.schema_name, name: row.table_name });
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
      await writer.write(`IF OBJECT_ID(N'${nLiteral(tbl)}', 'U') IS NOT NULL DROP TABLE ${tbl};\n`);

      // CREATE TABLE from sys.sql_modules — mssql has no SHOW CREATE TABLE.
      const def = (await runMeta(pool, DDL_SQL, { qualified: label }))[0]?.definition;
      if (!def) throw new Error(`no DDL found for ${label}`);
      await writer.write(`${def};\n\n`);

      if (includeData) {
        // PK inference mirrors tableMeta (information_schema constraints).
        // pkCols order is the single source for both the page ORDER BY and
        // the keyset predicate below.
        const pkRows = await runMeta(pool, PK_SQL_SCHEMA, { s: entry.schema, t: entry.name });
        const pkCols = pkRows.map((r) => r.column_name).filter(Boolean);
        const order = pkCols.length ? ` ORDER BY ${pkCols.map(q).join(", ")}` : " ORDER BY (SELECT NULL)";
        // Keyset cursor: the last page's PK values compared per column
        // (mssqlLiteral renders BIT/varbinary PKs restorable too). Without a
        // PK rows stream via OFFSET 0 / FETCH NEXT (one pass).
        let lastPkValues = null;
        let rowsDone = 0;
        for (;;) {
          if (!senderAlive()) throw new Error("renderer gone — backup aborted");
          const keyset = pkCols.length && lastPkValues ? keysetPredicate(pkCols, lastPkValues) : "";
          const page = await pool.request().query(
            `SELECT * FROM ${tbl}${keyset}${order} OFFSET 0 ROWS FETCH NEXT ${DUMP_PAGE_SIZE} ROWS ONLY`,
          );
          const rows = (page.recordsets && page.recordsets[0]) || [];
          if (rows.length > 0) {
            // Row objects → value arrays in first-row key order; values stay
            // RAW for sqlLiteral (Dates/objects render as-is).
            const columns = Object.keys(rows[0]);
            const valueRows = rows.map((row) => columns.map((name) => (row == null ? null : row[name])));
            const statements = buildInsertStatements({
              tableRef: tbl, quote: q, columns, rows: valueRows,
              literal: mssqlLiteral,
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
          await push({ phase: "rows", table: label, rowsDone });
        }
        await push({ phase: "rows", table: label, rowsDone });
      }
      await writer.write("\n");
      tablesDone += 1;
    }

    // Views are emitted AFTER all tables so their base tables exist at
    // CREATE VIEW time. Definitions come from sys.sql_modules too.
    if (scope === "database" && dumpViews.length > 0) {
      await push({ phase: "views" });
      for (const view of dumpViews) {
        if (!senderAlive()) throw new Error("renderer gone — backup aborted");
        const vtbl = `${q(view.schema)}.${q(view.name)}`;
        await writer.write(`IF OBJECT_ID(N'${nLiteral(vtbl)}', 'V') IS NOT NULL DROP VIEW ${vtbl};\n`);
        const def = (await runMeta(pool, DDL_SQL, { qualified: `${view.schema}.${view.name}` }))[0]?.definition;
        if (!def) throw new Error(`no DDL found for view ${view.schema}.${view.name}`);
        await writer.write(`${def};\n\n`);
      }
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
  ipcMain.handle("quolldesk:mssql:connect", async (event, opts = {}) => {
    if (!opts.hostname || !Number.isInteger(opts.port)) {
      return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, "hostname and integer port are required");
    }
    try {
      const pool = await connectPool(opts);
      const connectionId = registry.registerConnection({
        dialect: "mssql",
        senderId: event.sender.id,
        client: { pool },
        tunnel: null,
        meta: {
          hostname: opts.hostname,
          port: opts.port,
          database: opts.config?.database ?? null,
          username: opts.username ?? null,
        },
        close: () => {
          try { pool.close(); } catch { /* ignore */ }
        },
      });
      // The mssql pool emits 'error'/'end' on fatal failures; optional-called
      // so fakes without EventEmitter still work.
      watchDriverDeath(pool, connectionId, registry);
      return okEnvelope({ connectionId });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "connect failed");
    }
  });

  ipcMain.handle("quolldesk:mssql:disconnect", async (_event, { connectionId } = {}) => {
    if (!connectionId) return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, "connectionId required");
    registry.closeConnection(connectionId, "user");
    return okEnvelope({});
  });

  ipcMain.handle("quolldesk:mssql:test", async (_event, opts = {}) => {
    if (!opts.hostname || !Number.isInteger(opts.port)) {
      return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, "hostname and integer port are required");
    }
    let pool = null;
    const started = Date.now();
    try {
      pool = await connectPool(opts);
      const res = await pool.request().query("SELECT @@VERSION AS v");
      return okEnvelope({
        latencyMs: Date.now() - started,
        serverVersion: String(res.recordset?.[0]?.v || "unknown"),
      });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "test failed");
    } finally {
      if (pool) { try { await pool.close(); } catch { /* ignore */ } }
    }
  });

  ipcMain.handle("quolldesk:mssql:schemaTree", async (_event, { connectionId } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry) return errorEnvelope(DB_ERROR_CODES.NOT_CONNECTED, "not connected");
    registry.touchConnection(connectionId);
    try {
      // Single round trip (see SCHEMA_LISTING_SQL); grouped in row order.
      const rows = await runMeta(entry.client.pool, SCHEMA_LISTING_SQL);
      const databases = [];
      let current = null;
      for (const row of rows) {
        if (!current || current.name !== row.schema_name) {
          current = { name: row.schema_name, tables: [], views: [] };
          databases.push(current);
        }
        if (row.table_name == null) continue; // empty schema: no sys.objects match
        if (row.kind === "V") current.views.push(row.table_name);
        else current.tables.push(row.table_name);
      }
      return okEnvelope({ databases });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "schemaTree failed");
    }
  });

  // Group the ordered per-column FK rows into composite-capable constraints
  // (canonical FK shape shared across the four bridges).
  const buildForeignKeys = (fkRows) => {
    const seen = new Map();
    for (const r of fkRows) {
      const fk = seen.get(r.name)
        || { name: r.name, columns: [], refTable: r.ref_table, refSchema: r.ref_schema, refColumns: [], onDelete: r.on_delete || null, onUpdate: r.on_update || null };
      fk.columns.push(r.column_name);
      fk.refColumns.push(r.ref_column);
      seen.set(r.name, fk);
    }
    return [...seen.values()];
  };

  ipcMain.handle("quolldesk:mssql:tableMeta", async (_event, { connectionId, table, schema } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry || !table) return errorEnvelope(entry ? DB_ERROR_CODES.INVALID_PARAMS : DB_ERROR_CODES.NOT_CONNECTED, entry ? "table required" : "not connected");
    registry.touchConnection(connectionId);
    // OBJECT_ID accepts an unquoted two-part name; without a schema the
    // session default (dbo for most logins) resolves it.
    const qualified = schema ? `${schema}.${table}` : table;
    try {
      // INFORMATION_SCHEMA parts stay sequential-per-query but run together
      // via Promise.all (one request each on the pool).
      const [columns, pkRows, indexRows, ddlRows, countRows, fkRows, triggerRows] = await Promise.all([
        runMeta(entry.client.pool, schema ? COLUMNS_SQL_SCHEMA : COLUMNS_SQL_CURRENT, { s: schema, t: table }),
        runMeta(entry.client.pool, schema ? PK_SQL_SCHEMA : PK_SQL_CURRENT, { s: schema, t: table }),
        runMeta(entry.client.pool, INDEXES_SQL, { qualified }),
        runMeta(entry.client.pool, DDL_SQL, { qualified }),
        runMeta(entry.client.pool, ROW_COUNT_SQL, { qualified }),
        runMeta(entry.client.pool, FK_SQL, { qualified }),
        runMeta(entry.client.pool, TRIGGERS_SQL, { qualified }),
      ]);
      const pkCols = pkRows.map((r) => r.column_name).filter(Boolean);
      const pkSet = new Set(pkCols);
      const seen = new Map();
      for (const row of indexRows) {
        // The PK's backing index duplicates the primaryKey payload — skip it.
        if (row.is_primary_key === true) continue;
        const idx = seen.get(row.name)
          || { name: row.name, columns: [], unique: row.is_unique === true, method: String(row.type_desc || "") };
        idx.columns.push(row.column_name);
        seen.set(row.name, idx);
      }
      return okEnvelope({
        columns: columns.map((c) => ({
          name: c.COLUMN_NAME, type: c.DATA_TYPE, nullable: c.IS_NULLABLE === "YES",
          defaultValue: c.COLUMN_DEFAULT, key: pkSet.has(c.COLUMN_NAME) ? "PRI" : null,
          comment: c.COLUMN_COMMENT || null,
        })),
        indexes: [...seen.values()],
        primaryKey: pkCols.length > 0 ? { name: pkRows[0]?.constraint_name || null, columns: pkCols } : null,
        ddl: ddlRows[0]?.definition ?? null,
        foreignKeys: buildForeignKeys(fkRows),
        triggers: buildTriggerMetas(triggerRows),
        rowCountEstimate: Number(countRows[0]?.c ?? 0),
      });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "tableMeta failed");
    }
  });

  ipcMain.handle("quolldesk:mssql:tableRows", async (_event, { connectionId, table, schema, orderBy, orderDir, filters, offset = 0, limit = 100 } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry || !table) return errorEnvelope(entry ? DB_ERROR_CODES.INVALID_PARAMS : DB_ERROR_CODES.NOT_CONNECTED, entry ? "table required" : "not connected");
    registry.touchConnection(connectionId);
    const pageLimit = Math.min(Math.max(1, Number(limit) || 100), MAX_ROWS);
    const tbl = `${schema ? q(schema) + "." : ""}${q(table)}`;
    const dir = orderDir === "asc" ? " ASC" : orderDir === "desc" ? " DESC" : "";
    const order = orderBy ? ` ORDER BY ${q(orderBy)}${dir}` : " ORDER BY (SELECT NULL)";
    // gridWhere's placeholder callback receives the 1-based bind index
    // (values.length + 1) — render @p1..@pN and input the values in order.
    const { where, values } = buildGridWhere(filters, { quote: q, placeholder: (i) => `@p${i}` });
    try {
      const req = entry.client.pool.request();
      values.forEach((v, i) => req.input(`p${i + 1}`, v));
      const res = await req.query(
        `SELECT * FROM ${tbl}${where}${order} OFFSET ${Math.max(0, Number(offset) || 0)} ROWS FETCH NEXT ${pageLimit} ROWS ONLY`,
      );
      const rs = toResultSet((res.recordsets && res.recordsets[0]) || []);
      return okEnvelope({ columns: rs.columns, rows: rs.rows, truncated: rs.truncated });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "tableRows failed");
    }
  });

  // Apply pending grid edits transactionally: one tedious transaction, all
  // statements committed together or rolled back on any failure.
  ipcMain.handle("quolldesk:mssql:applyTableChanges", async (_event, { connectionId, table, schema, changes = {} } = {}) => {
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
    const pool = entry.client.pool;
    let tx = null;
    try {
      tx = new (getDriver()).Transaction(pool);
      await tx.begin();
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "apply failed");
    }
    try {
      const applied = { updates: 0, inserts: 0, deletes: 0 };
      // Fresh Request per statement: tedious forbids re-declaring a parameter
      // name on one Request (EDUPEPARAM).
      for (const u of updates) {
        if (!u.pk || !u.column || u.pkValue == null) throw new Error("invalid update entry");
        const req = new (getDriver()).Request(tx);
        req.input("v", u.value === null ? null : String(u.value));
        req.input("pkv", String(u.pkValue));
        await req.query(`UPDATE ${tbl} SET ${q(u.column)} = @v WHERE ${q(u.pk)} = @pkv`);
        applied.updates += 1;
      }
      for (const ins of inserts) {
        const cols = Object.keys(ins.values || {});
        if (cols.length === 0) continue;
        const req = new (getDriver()).Request(tx);
        cols.forEach((c, i) => req.input(`p${i + 1}`, ins.values[c] === null ? null : String(ins.values[c])));
        await req.query(`INSERT INTO ${tbl} (${cols.map(q).join(", ")}) VALUES (${cols.map((_, i) => `@p${i + 1}`).join(", ")})`);
        applied.inserts += 1;
      }
      for (const d of deletes) {
        if (!d.pk || d.pkValue == null) throw new Error("invalid delete entry");
        const req = new (getDriver()).Request(tx);
        req.input("pkv", String(d.pkValue));
        await req.query(`DELETE FROM ${tbl} WHERE ${q(d.pk)} = @pkv`);
        applied.deletes += 1;
      }
      await tx.commit();
      return okEnvelope({ applied });
    } catch (err) {
      try { await tx.rollback(); } catch { /* connection may be broken; registry reaps it */ }
      return errorEnvelope(classifyDriverError(err), err?.message || "apply failed");
    }
  });

  ipcMain.handle("quolldesk:mssql:query", async (_event, { connectionId, sql, values, timeoutMs } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry || !sql || !String(sql).trim()) {
      return errorEnvelope(entry ? DB_ERROR_CODES.INVALID_PARAMS : DB_ERROR_CODES.NOT_CONNECTED, entry ? "sql required" : "not connected");
    }
    registry.touchConnection(connectionId);
    const started = Date.now();
    try {
      // v12 exposes no request.timeout property — the per-request timeout is
      // a Request override: pool.request({ requestTimeout }).
      const req = entry.client.pool.request({
        requestTimeout: Math.min(Math.max(1, Number(timeoutMs) || DEFAULT_QUERY_TIMEOUT_MS), MAX_QUERY_TIMEOUT_MS),
      });
      (values || []).forEach((v, i) => req.input(`p${i + 1}`, v));
      const res = await req.query(String(sql));
      const recordsets = Array.isArray(res.recordsets) ? res.recordsets : [];
      // tedious flattens rowsAffected across every statement in the batch.
      const affectedTotal = (res.rowsAffected || []).reduce((sum, n) => sum + (Number(n) || 0), 0);
      const resultSets = recordsets.map((rs) => toResultSet(rs));
      // Attach the aggregate to the last column-less result set; a pure-DML
      // batch (no recordsets at all) gets a synthetic trailing set, mirroring
      // the mysql okPacket segment. Mixed batches cannot attribute counts
      // per statement (tedious only reports the flat rowsAffected list).
      let target = null;
      for (let i = resultSets.length - 1; i >= 0; i -= 1) {
        if (!resultSets[i].columns.length) { target = resultSets[i]; break; }
      }
      if (target) target.affectedRows = affectedTotal;
      else if (recordsets.length === 0) {
        resultSets.push({ columns: [], rows: [], affectedRows: affectedTotal, truncated: false });
      }
      return okEnvelope({
        resultSets,
        executionTimeMs: Date.now() - started,
        truncated: resultSets.some((rs) => rs.truncated),
      });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "query failed");
    }
  });

  // ---- Backup / restore ----

  // Session manager: sys.dm_exec_sessions (this connection's session excluded
  // via @@SPID) + KILL / KILL <only> cancel via ALTER … KILL QUERY.
  ipcMain.handle("quolldesk:mssql:sessions", async (_event, { connectionId } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry) return errorEnvelope(DB_ERROR_CODES.NOT_CONNECTED, "not connected");
    registry.touchConnection(connectionId);
    try {
      const rows = await runMeta(entry.client.pool,
        "SELECT s.session_id, s.login_name AS login_name, s.host_name AS host_name, s.status, " +
        "DATEDIFF(second, s.last_request_start_time, GETDATE()) AS seconds, " +
        "COALESCE(CAST(r.command AS nvarchar(64)), '') AS command " +
        "FROM sys.dm_exec_sessions s LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id " +
        "WHERE s.session_id <> @@SPID AND s.is_user_process = 1 ORDER BY s.session_id");
      const sessions = rows.map((r) => ({
        id: String(r.session_id), user: String(r.login_name || ''), app: String(r.host_name || ''),
        state: `${String(r.status || '')}${r.command ? ` / ${r.command}` : ''}`,
        seconds: Number(r.seconds || 0), query: '',
      }));
      return okEnvelope({ sessions });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "sessions failed");
    }
  });

  ipcMain.handle("quolldesk:mssql:killSession", async (_event, { connectionId, pid, cancel } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry || !pid) return errorEnvelope(entry ? DB_ERROR_CODES.INVALID_PARAMS : DB_ERROR_CODES.NOT_CONNECTED, entry ? "session id required" : "not connected");
    registry.touchConnection(connectionId);
    try {
      const id = Number(pid);
      if (!Number.isInteger(id) || id <= 0) return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, "invalid session id");
      const req = entry.client.pool.request();
      await req.query(cancel ? `KILL ${id}` : `KILL ${id}`);
      return okEnvelope({});
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "kill failed");
    }
  });

  registerSqlDialogHandlers(ipcMain, "quolldesk:mssql");

  // Async dump job: the invoke returns { jobId } immediately; progress and
  // completion arrive on quolldesk:db:jobProgress. One job per connection.
  ipcMain.handle("quolldesk:mssql:backup", async (event, { connectionId, scope = "database", schema = "dbo", table, includeData = true, outFile } = {}) => {
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
    void runMssqlBackup({
      event, pool: entry.client.pool, connectionId, jobId: job.jobId, scope, schema, table, includeData, outFile,
    }).finally(job.release);
    return okEnvelope({ jobId: job.jobId });
  });

  // File restore: reads the SQL file, splits it with the quote/comment-aware
  // splitter (mssql mode: bracket identifiers, backslash literal) and executes
  // statements sequentially. Already-executed statements stay applied on a
  // mid-file error (reported with its statement index via the error push).
  // GO batch separators are not supported in v1 — GO lines inside the file
  // surface as driver syntax errors on the affected statement.
  ipcMain.handle("quolldesk:mssql:restore", async (event, { connectionId, inFile } = {}) => {
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
    const statements = splitSqlStatements(text, "mssql");
    registry.touchConnection(connectionId);
    void runSequentialRestore({
      event, jobId: job.jobId, dialect: "mssql", statements,
      exec: (statement) => entry.client.pool.request().query(statement),
    }).finally(job.release);
    return okEnvelope({ jobId: job.jobId });
  });
}

function closeAllForSender(senderId) { return registry.closeAllForSender(senderId); }

module.exports = {
  registerHandlers, closeAllForSender, _setDriverForTests, _setDialogForTests, runLimitedQuery, runQuery, runReadOnlyBatch, EXCLUDED_SCHEMAS,
};
