"use strict";

const { CAPABILITY_STATUS } = require("../constants.cjs");

/** @type {import("../types.cjs").CapabilityDefinition[]} */
const DATABASE_CAPABILITIES = [
  {
    id: "database.connections.list",
    domain: "database",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description:
      "List database connections that are currently open in the QuollDesk database workbench (dialect, host, port, database name — never credentials). Only open connections work with the other database tools; call this first to obtain connectionId values.",
    policy: { write: false, sensitiveRead: true, longRunning: false, requiresChatSession: false, bypassesObserverBlock: false, bypassesApproval: true, bypassesChatCancel: true },
    surfaces: {
      global: { rpcMethod: "database/connections/list" },
      public: { rpcMethod: "public/database/connections/list", mcpTool: "database_connections_list" },
    },
  },
  {
    id: "database.schema",
    domain: "database",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description:
      "Get schema metadata for an open MySQL/PostgreSQL connection. Without `table`: list tables (schema, name, kind). With `table`: return that table's columns (name, data type, nullable, default, primary key flag). Always inspect the schema before writing SQL so identifiers and columns actually exist.",
    policy: { write: false, sensitiveRead: false, longRunning: false, requiresChatSession: false, bypassesObserverBlock: false, bypassesApproval: true, bypassesChatCancel: true },
    surfaces: {
      global: { rpcMethod: "database/schema" },
      public: { rpcMethod: "public/database/schema", mcpTool: "database_schema" },
    },
  },
  {
    id: "database.query",
    domain: "database",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description:
      "Run READ-ONLY SQL on an open MySQL/PostgreSQL connection (SELECT / SHOW / EXPLAIN / DESC / WITH…SELECT). Executed inside a READ ONLY transaction; any write attempt is rejected — use database_execute for writes. Multiple statements are allowed but every statement must be read-only. Rows and cells may be truncated.",
    policy: { write: false, sensitiveRead: true, longRunning: false, requiresChatSession: false, bypassesObserverBlock: false, bypassesApproval: true, bypassesChatCancel: true },
    surfaces: {
      global: { rpcMethod: "database/query" },
      public: { rpcMethod: "public/database/query", mcpTool: "database_query" },
    },
  },
  {
    id: "database.execute",
    domain: "database",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description:
      "Execute SQL that mutates data or schema on an open MySQL/PostgreSQL connection (INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/TRUNCATE…). Requires user approval in confirm mode and is blocked in observer mode. Re-verify WHERE clauses on UPDATE/DELETE; the user sees the full SQL in the approval prompt.",
    policy: { write: true, sensitiveRead: false, longRunning: false, requiresChatSession: false, bypassesObserverBlock: false, bypassesApproval: false, bypassesChatCancel: false },
    surfaces: {
      global: { rpcMethod: "database/execute" },
      public: { rpcMethod: "public/database/execute", mcpTool: "database_execute" },
    },
  },
  {
    id: "redis.keys.scan",
    domain: "database",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description:
      "Scan keys of an open Redis connection with cursor pagination (SCAN). Returns key names and the next cursor — pass the cursor back until it equals \"0\". Optional match pattern (auto-wrapped with *), count, and cluster nodeId. Prefer this over KEYS.",
    policy: { write: false, sensitiveRead: false, longRunning: false, requiresChatSession: false, bypassesObserverBlock: false, bypassesApproval: true, bypassesChatCancel: true },
    surfaces: {
      global: { rpcMethod: "redis/keys/scan" },
      public: { rpcMethod: "public/redis/keys/scan", mcpTool: "redis_keys_scan" },
    },
  },
  {
    id: "redis.key.get",
    domain: "database",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description:
      "Read one key of an open Redis connection: type, TTL, and (paged) value for string/hash/list/set/zset/stream. Large values are truncated. Use redis_keys_scan first to find keys.",
    policy: { write: false, sensitiveRead: true, longRunning: false, requiresChatSession: false, bypassesObserverBlock: false, bypassesApproval: true, bypassesChatCancel: true },
    surfaces: {
      global: { rpcMethod: "redis/key/get" },
      public: { rpcMethod: "public/redis/key/get", mcpTool: "redis_key_get" },
    },
  },
  {
    id: "redis.key.edit",
    domain: "database",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description:
      "Create/modify/delete a Redis key on an open connection. action is one of: stringSet, hset, hdel, lpush, rpush, lrem, sadd, srem, zadd, zrem, expire (ttlSeconds, 0 = persist), rename (newKey), delete. Requires approval in confirm mode; blocked in observer mode.",
    policy: { write: true, sensitiveRead: false, longRunning: false, requiresChatSession: false, bypassesObserverBlock: false, bypassesApproval: false, bypassesChatCancel: false },
    surfaces: {
      global: { rpcMethod: "redis/key/edit" },
      public: { rpcMethod: "public/redis/key/edit", mcpTool: "redis_key_edit" },
    },
  },
  {
    id: "redis.command",
    domain: "database",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description:
      "Run a raw Redis command on an open connection through the same guard as the Redis console (blocking SUBSCRIBE/SELECT and friends). Prefer redis_keys_scan / redis_key_get / redis_key_edit when they fit. Requires approval in confirm mode; blocked in observer mode.",
    policy: { write: true, sensitiveRead: false, longRunning: false, requiresChatSession: false, bypassesObserverBlock: false, bypassesApproval: false, bypassesChatCancel: false },
    surfaces: {
      global: { rpcMethod: "redis/command" },
      public: { rpcMethod: "public/redis/command", mcpTool: "redis_command" },
    },
  },
];

module.exports = { DATABASE_CAPABILITIES };
