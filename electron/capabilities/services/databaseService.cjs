"use strict";

// Capability service behind the database.* / redis.* AI & MCP tools.
// A connection is usable only while it is open in the database workbench:
// every call resolves the connection through the shared connectionRegistry,
// which is the "only currently open connections" boundary (spec §3.3).
//
// Error shape: flat capability results ({ ok: false, code, error }), never
// throws; driver failures map through classifyDriverError. Credentials never
// cross this boundary (meta is hostname/port/database/username only), and the
// service never mutates shared connection state (no Redis SELECT on the dial).

const connectionRegistry = require("../../bridges/dbCommon/connectionRegistry.cjs");
const { errorEnvelope, classifyDriverError, DB_ERROR_CODES, serializeCellValue } = require("../../bridges/dbCommon/resultEnvelope.cjs");
const { validateReadOnlySql, readOnlyTransaction } = require("../../bridges/dbCommon/readOnlySql.cjs");
const redisBridge = require("../../bridges/redisBridge.cjs");
const mysqlBridge = require("../../bridges/mysqlBridge.cjs");
const pgBridge = require("../../bridges/pgBridge.cjs");

const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
const MAX_QUERY_TIMEOUT_MS = 120_000;
const SQL_MAX_ROWS = 1000; // mirrors the bridges' MAX_ROWS
const REDIS_VALUE_PAGE = 200;

// Tool-domain predicate shared with the renderer-side filter (capabilityTools.ts
// keeps its own copy — a CJS/TS shared module is not worth the plumbing).
function isDatabaseCapabilityId(capabilityId) {
  return capabilityId.startsWith("database.") || capabilityId.startsWith("redis.");
}

function createDatabaseService(deps = {}) {
  const registry = deps.registry || connectionRegistry;
  const redis = deps.redisBridge || redisBridge;
  const mysql = deps.mysqlBridge || mysqlBridge;
  const pg = deps.pgBridge || pgBridge;
  // Optional per-chat narrowing installed by the mcpServerBridge wiring:
  // chatSessionId -> Set<connectionId>. Absent entry = open connections allowed.
  const getScopedDbConnectionIds = deps.getScopedDbConnectionIds || (() => null);

  const fail = (code, error) => ({ ok: false, code, error });
  const fromEnvelope = (envelope) => envelope && envelope.ok === true
    ? { ok: true, ...envelope.data }
    : fail(envelope?.error?.code || DB_ERROR_CODES.INTERNAL, envelope?.error?.message || "Database error");

  function requireOpenConnection(params, dialects) {
    const connectionId = params?.connectionId;
    if (!connectionId || typeof connectionId !== "string") {
      return { error: fail(DB_ERROR_CODES.INVALID_PARAMS, "connectionId is required.") };
    }
    const scoped = getScopedDbConnectionIds(params?.chatSessionId);
    if (scoped && !scoped.has(connectionId)) {
      return { error: fail(DB_ERROR_CODES.PERMISSION_DENIED, "Connection is outside this chat's database scope.") };
    }
    const entry = registry.getConnection(connectionId);
    if (!entry) {
      return { error: fail(DB_ERROR_CODES.NOT_CONNECTED, "Connection is not open. Open it in the database workbench (or call database_connections_list) first.") };
    }
    if (dialects && !dialects.includes(entry.dialect)) {
      return { error: fail(DB_ERROR_CODES.INVALID_PARAMS, `connectionId is not a ${dialects.join("/")} connection.`) };
    }
    registry.touchConnection(connectionId);
    return { entry };
  }

  function clampTimeout(timeoutMs) {
    const n = Number(timeoutMs);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_QUERY_TIMEOUT_MS;
    return Math.min(Math.round(n), MAX_QUERY_TIMEOUT_MS);
  }

  // runLimitedQuery's downgrade path (fake drivers / no stream support) returns
  // rows as cellified ARRAYS zipped against columns; the stream path returns
  // row objects. Normalize both to object rows for tool output.
  function rowsAsObjects(res) {
    const columns = res.columns || [];
    const rows = res.rows || [];
    if (rows.length && Array.isArray(rows[0])) {
      const names = columns.map((c) => c?.name ?? String(c));
      return rows.map((arr) => Object.fromEntries(names.map((name, i) => [name, arr[i]])));
    }
    return rows;
  }

  async function listConnections(params) {
    const dialect = params?.dialect ? String(params.dialect) : null;
    const connections = registry.listConnections()
      .filter((c) => !dialect || c.dialect === dialect)
      .map((c) => ({
        connectionId: c.id,
        dialect: c.dialect,
        hostname: c.meta?.hostname ?? null,
        port: c.meta?.port ?? null,
        database: c.meta?.database ?? null,
        username: c.meta?.username ?? null,
      }));
    return { ok: true, connections };
  }

  // ---- SQL schema metadata (information_schema based, dialect-aware) ----

  async function sqlSchema(params) {
    const guard = requireOpenConnection(params, ["mysql", "postgresql"]);
    if (guard.error) return guard.error;
    try {
      return guard.entry.dialect === "mysql"
        ? await sqlSchemaMysql(guard.entry, params)
        : await sqlSchemaPg(guard.entry, params);
    } catch (err) {
      return fromEnvelope(errorEnvelope(classifyDriverError(err), err?.message || "schema fetch failed"));
    }
  }

  async function sqlSchemaMysql(entry, params) {
    const conn = entry.client.conn;
    const schema = params?.schema ? String(params.schema) : null;
    const table = params?.table ? String(params.table) : null;
    if (!table) {
      const where = schema ? "table_schema = ?" : "table_schema = DATABASE()";
      const values = schema ? [schema] : [];
      const segments = await mysql.runQuery(conn,
        `SELECT table_schema AS \`schema\`, table_name AS \`name\`, table_type AS \`kind\` FROM information_schema.tables WHERE ${where} ORDER BY table_schema, table_name`,
        DEFAULT_QUERY_TIMEOUT_MS, values);
      return { ok: true, tables: segments[0]?.rows || [] };
    }
    const schemaClause = schema ? "table_schema = ? AND table_name = ?" : "table_schema = DATABASE() AND table_name = ?";
    const values = schema ? [schema, table] : [table];
    const segments = await mysql.runQuery(conn,
      `SELECT column_name, data_type, is_nullable, column_default, column_key FROM information_schema.columns WHERE ${schemaClause} ORDER BY ordinal_position`,
      DEFAULT_QUERY_TIMEOUT_MS, values);
    const columns = segments[0]?.rows || [];
    return {
      ok: true,
      table,
      columns,
      primaryKey: columns.filter((c) => c.column_key === "PRI").map((c) => c.column_name),
    };
  }

  async function sqlSchemaPg(entry, params) {
    const client = entry.client.client;
    const schema = params?.schema ? String(params.schema) : "public";
    const table = params?.table ? String(params.table) : null;
    if (!table) {
      const res = await pg.runLimitedQuery(client,
        "SELECT table_schema AS \"schema\", table_name AS \"name\", table_type AS \"kind\" FROM information_schema.tables WHERE table_schema = $1 AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1, 2",
        [schema]);
      return { ok: true, tables: rowsAsObjects(res) };
    }
    const columnsRes = await pg.runLimitedQuery(client,
      "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
      [schema, table]);
    const pkRes = await pg.runLimitedQuery(client,
      "SELECT c.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage c ON tc.constraint_name = c.constraint_name AND tc.table_schema = c.table_schema WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY' ORDER BY c.ordinal_position",
      [schema, table]);
    return {
      ok: true,
      table,
      columns: rowsAsObjects(columnsRes),
      primaryKey: rowsAsObjects(pkRes).map((r) => r.column_name),
    };
  }

  // ---- query (read-only, wrapped in a READ ONLY transaction) / execute ----

  async function sqlQuery(params) {
    const guard = requireOpenConnection(params, ["mysql", "postgresql"]);
    if (guard.error) return guard.error;
    const entry = guard.entry;
    const dialect = entry.dialect;
    const sql = String(params?.sql || "");
    const timeoutMs = clampTimeout(params?.timeoutMs);
    const gate = validateReadOnlySql(dialect, sql);
    if (!gate.ok) return { ok: false, code: gate.code, error: gate.error };
    const txn = readOnlyTransaction(dialect);
    const startedAt = Date.now();
    try {
      if (dialect === "mysql") {
        const conn = entry.client.conn;
        const exec = (s) => new Promise((resolve, reject) => conn.query(s, (err, result) => (err ? reject(err) : resolve(result))));
        await exec(txn.begin);
        try {
          const segments = await mysql.runQuery(conn, sql, timeoutMs);
          const resultSets = segments.map((segment) => {
            const columns = (segment.columns || []).map((f) => ({ name: f?.name ?? f?.Field ?? String(f) }));
            const names = columns.map((c) => c.name);
            const rows = (segment.rows || []).map((row) =>
              Object.fromEntries(names.map((name, i) => [name, serializeCellValue(row?.[name])])));
            return {
              columns,
              rows,
              rowCount: segment.rows?.length ?? 0,
              okPacket: segment.okPacket || null,
              truncated: Boolean(segment.truncated),
            };
          });
          return { ok: true, dialect, resultSets, executionTimeMs: Date.now() - startedAt, readOnly: true };
        } finally {
          await exec(txn.end).catch(() => {});
        }
      }
      const client = entry.client.client;
      await client.query(txn.begin);
      try {
        if (gate.statements.length === 1) {
          const res = await pg.runLimitedQuery(client, sql, undefined);
          const rows = rowsAsObjects(res);
          return {
            ok: true, dialect,
            resultSets: [{ columns: res.columns || [], rows, rowCount: rows.length, okPacket: null, truncated: Boolean(res.truncated) }],
            executionTimeMs: Date.now() - startedAt,
            readOnly: true,
          };
        }
        // pg simple protocol: multi-statement scripts resolve as an array of
        // per-statement results; only the last carries usable rows/rowCount.
        const res = await client.query({ text: sql, values: undefined });
        const last = Array.isArray(res) ? res[res.length - 1] : res;
        const rawRows = last?.rows || [];
        const rows = rawRows.slice(0, SQL_MAX_ROWS);
        return {
          ok: true, dialect,
          resultSets: [{
            columns: rows[0] ? Object.keys(rows[0]).map((name) => ({ name })) : [],
            rows,
            rowCount: last?.rowCount ?? rows.length,
            okPacket: null,
            truncated: rawRows.length > SQL_MAX_ROWS,
          }],
          executionTimeMs: Date.now() - startedAt,
          readOnly: true,
        };
      } finally {
        await client.query(txn.end).catch(() => {});
      }
    } catch (err) {
      return fromEnvelope(errorEnvelope(classifyDriverError(err), err?.message || "query failed"));
    }
  }

  async function sqlExecute(params) {
    const guard = requireOpenConnection(params, ["mysql", "postgresql"]);
    if (guard.error) return guard.error;
    const entry = guard.entry;
    const sql = String(params?.sql || "").trim();
    if (!sql) return fail(DB_ERROR_CODES.INVALID_PARAMS, "sql is required.");
    try {
      if (entry.dialect === "mysql") {
        const segments = await mysql.runQuery(entry.client.conn, sql, clampTimeout(params?.timeoutMs));
        const resultSets = segments.map((segment) => ({
          columns: (segment.columns || []).map((f) => ({ name: f?.name ?? f?.Field ?? String(f) })),
          rows: segment.rows || [],
          rowCount: segment.rows?.length ?? 0,
          affectedRows: segment.okPacket?.affectedRows ?? null,
          insertId: segment.okPacket?.insertId ?? null,
          truncated: Boolean(segment.truncated),
        }));
        return { ok: true, dialect: "mysql", resultSets };
      }
      // Direct client.query (not runFullQuery) to keep rowCount/command for DML.
      const res = await entry.client.client.query({ text: sql, values: undefined });
      const last = Array.isArray(res) ? res[res.length - 1] : res;
      return { ok: true, dialect: "postgresql", rowCount: last?.rowCount ?? null, command: last?.command ?? null };
    } catch (err) {
      return fromEnvelope(errorEnvelope(classifyDriverError(err), err?.message || "execute failed"));
    }
  }

  // ---- redis ----

  function redisClientFor(entry, nodeId) {
    return redis.nodeFor(entry.client, nodeId); // cluster-aware; falls back to dial.client
  }

  async function redisScanKeys(params) {
    const guard = requireOpenConnection(params, ["redis"]);
    if (guard.error) return guard.error;
    try {
      const client = await redisClientFor(guard.entry, params?.nodeId);
      const cursor = String(params?.cursor ?? "0") || "0";
      const count = Math.min(Math.max(Number(params?.count) || 200, 1), 5000);
      const rawMatch = params?.match ? String(params.match).trim() : "*";
      const pattern = rawMatch === "*" || /[*?[\]]/.test(rawMatch) ? rawMatch : `*${rawMatch}*`;
      const reply = await client.sendCommand(["SCAN", cursor, "MATCH", pattern, "COUNT", String(count)]);
      const keys = Array.isArray(reply?.[1]) ? reply[1].map((name) => ({ name: String(name) })) : [];
      return { ok: true, cursor: String(reply?.[0] ?? "0"), keys };
    } catch (err) {
      return fromEnvelope(errorEnvelope(classifyDriverError(err), err?.message || "SCAN failed"));
    }
  }

  function chunkPairs(flat) {
    const out = [];
    for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
    return out;
  }

  async function redisKeyGet(params) {
    const guard = requireOpenConnection(params, ["redis"]);
    if (guard.error) return guard.error;
    const key = String(params?.key || "");
    if (!key) return fail(DB_ERROR_CODES.INVALID_PARAMS, "key is required.");
    try {
      const client = await redisClientFor(guard.entry, params?.nodeId);
      const type = String(await client.sendCommand(["TYPE", key]));
      if (type === "none") return { ok: true, key, exists: false };
      const ttl = Number(await client.sendCommand(["TTL", key]));
      let value;
      let valueTruncated = false;
      if (type === "string") {
        value = redis.serializeReply(await client.sendCommand(["GET", key]));
      } else if (type === "hash") {
        const raw = await client.sendCommand(["HGETALL", key]);
        const pairs = Array.isArray(raw) ? chunkPairs(raw) : Object.entries(raw || {});
        value = pairs.slice(0, REDIS_VALUE_PAGE).map(([field, val]) => ({ field: String(field), value: redis.serializeReply(val) }));
        valueTruncated = pairs.length > REDIS_VALUE_PAGE;
      } else if (type === "list") {
        const len = Number(await client.sendCommand(["LLEN", key]));
        value = (await client.sendCommand(["LRANGE", key, "0", String(REDIS_VALUE_PAGE - 1)])).map((v) => redis.serializeReply(v));
        valueTruncated = value.length < len;
      } else if (type === "set") {
        const total = Number(await client.sendCommand(["SCARD", key]));
        value = (await client.sendCommand(["SMEMBERS", key])).slice(0, REDIS_VALUE_PAGE).map((v) => redis.serializeReply(v));
        valueTruncated = value.length < total;
      } else if (type === "zset") {
        const total = Number(await client.sendCommand(["ZCARD", key]));
        const flat = await client.sendCommand(["ZRANGE", key, "0", String(REDIS_VALUE_PAGE - 1), "WITHSCORES"]);
        value = chunkPairs(flat).map(([member, score]) => ({ member: redis.serializeReply(member), score: Number(score) }));
        valueTruncated = value.length < total;
      } else if (type === "stream") {
        const raw = await client.sendCommand(["XRANGE", key, "-", "+", "COUNT", String(REDIS_VALUE_PAGE)]);
        value = redis.serializeReply(raw);
        valueTruncated = Array.isArray(raw) && raw.length >= REDIS_VALUE_PAGE;
      } else {
        return fail(DB_ERROR_CODES.INVALID_PARAMS, `Unsupported key type: ${type}`);
      }
      return { ok: true, key, exists: true, type, ttlSeconds: ttl, value, valueTruncated };
    } catch (err) {
      return fromEnvelope(errorEnvelope(classifyDriverError(err), err?.message || "key read failed"));
    }
  }

  const REDIS_EDIT_ACTIONS = new Set([
    "stringSet", "hset", "hdel", "lpush", "rpush", "lrem", "sadd", "srem",
    "zadd", "zrem", "expire", "rename", "delete",
  ]);

  async function redisEditKey(params) {
    const guard = requireOpenConnection(params, ["redis"]);
    if (guard.error) return guard.error;
    const action = String(params?.action || "");
    const key = String(params?.key || "");
    if (!REDIS_EDIT_ACTIONS.has(action)) {
      return fail(DB_ERROR_CODES.INVALID_PARAMS, `action must be one of: ${[...REDIS_EDIT_ACTIONS].join(", ")}`);
    }
    if (!key) return fail(DB_ERROR_CODES.INVALID_PARAMS, "key is required.");
    const value = params?.value != null ? String(params.value) : null;
    const field = params?.field != null ? String(params.field) : null;
    const need = (v, label) => (v == null || v === "" ? fail(DB_ERROR_CODES.INVALID_PARAMS, `${label} is required for action "${action}".`) : null);
    let tokens;
    switch (action) {
      case "stringSet": {
        const e = need(value, "value"); if (e) return e;
        const ttl = Number(params?.ttlSeconds);
        tokens = ["SET", key, value, ...(Number.isFinite(ttl) && ttl > 0 ? ["EX", String(Math.round(ttl))] : [])];
        break;
      }
      case "hset": {
        for (const [v, label] of [[field, "field"], [value, "value"]]) { const e = need(v, label); if (e) return e; }
        tokens = ["HSET", key, field, value];
        break;
      }
      case "hdel": { const e = need(field, "field"); if (e) return e; tokens = ["HDEL", key, field]; break; }
      case "lpush": case "rpush": case "sadd": case "srem": {
        const e = need(value, "value"); if (e) return e;
        tokens = [action.toUpperCase(), key, value];
        break;
      }
      case "lrem": { const e = need(value, "value"); if (e) return e; tokens = ["LREM", key, "1", value]; break; }
      case "zadd": {
        const e = need(value, "value"); if (e) return e;
        const score = Number(params?.score);
        if (!Number.isFinite(score)) return fail(DB_ERROR_CODES.INVALID_PARAMS, "score is required for zadd.");
        tokens = ["ZADD", key, String(score), value];
        break;
      }
      case "zrem": { const e = need(value, "value"); if (e) return e; tokens = ["ZREM", key, value]; break; }
      case "expire": {
        const ttl = Number(params?.ttlSeconds);
        if (!Number.isFinite(ttl) || ttl < 0) return fail(DB_ERROR_CODES.INVALID_PARAMS, "ttlSeconds (>= 0) is required for expire; 0 persists the key.");
        tokens = ttl === 0 ? ["PERSIST", key] : ["EXPIRE", key, String(Math.round(ttl))];
        break;
      }
      case "rename": {
        const newKey = params?.newKey ? String(params.newKey) : null;
        const e = need(newKey, "newKey"); if (e) return e;
        tokens = ["RENAME", key, newKey];
        break;
      }
      case "delete": tokens = ["DEL", key]; break;
    }
    try {
      const client = await redisClientFor(guard.entry, params?.nodeId);
      const reply = await client.sendCommand(tokens);
      return { ok: true, action, key, reply: redis.serializeReply(reply) };
    } catch (err) {
      return fromEnvelope(errorEnvelope(classifyDriverError(err), err?.message || "key edit failed"));
    }
  }

  async function redisCommand(params) {
    const guard = requireOpenConnection(params, ["redis"]);
    if (guard.error) return guard.error;
    const tokens = redis.splitCommandLine(String(params?.command || ""));
    if (!tokens.length) return fail(DB_ERROR_CODES.INVALID_PARAMS, "command is required.");
    const head = String(tokens[0]).toUpperCase();
    if (redis.CONSOLE_BLOCKED_COMMANDS.has(head)) {
      return fail(DB_ERROR_CODES.INVALID_PARAMS, `${head} is blocked (same guard as the Redis console). Use the Pub/Sub page for subscriptions and the workbench db selector for SELECT.`);
    }
    try {
      const client = await redisClientFor(guard.entry, params?.nodeId);
      const reply = await client.sendCommand(tokens);
      return { ok: true, command: tokens.join(" "), reply: redis.serializeReply(reply) };
    } catch (err) {
      return fromEnvelope(errorEnvelope(classifyDriverError(err), err?.message || "command failed"));
    }
  }

  return { listConnections, schema: sqlSchema, query: sqlQuery, execute: sqlExecute, redisScanKeys, redisGetKey: redisKeyGet, redisEditKey, redisCommand };
}

module.exports = { createDatabaseService, isDatabaseCapabilityId };
