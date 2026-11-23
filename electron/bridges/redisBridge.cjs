"use strict";

/**
 * Redis Bridge - GUI client backend.
 * Channels: quolldesk:redis:{connect,disconnect,test,scan,keyMeta,keyValue,serverInfo,
 *   selectDb,keyTypes,subscribe,unsubscribe,runCommand} (+ pubsubMessage push)
 * Key management: quolldesk:redis:{createKey,deleteKey,renameKey,expireKey,setStringValue,
 *   hashSetField,hashDeleteField,listPush,listRemoveValue,setAddMember,setRemoveMember,
 *   zsetAddMember,zsetRemoveMember}
 */

const { randomUUID } = require("node:crypto");

const registry = require("./dbCommon/connectionRegistry.cjs");
const { openDbTunnel } = require("./dbCommon/tunnel.cjs");
const { watchDriverDeath } = require("./dbCommon/closeNotifier.cjs");
const {
  okEnvelope, errorEnvelope, DB_ERROR_CODES, classifyDriverError,
} = require("./dbCommon/resultEnvelope.cjs");

const SCAN_COUNT_DEFAULT = 200;
const VALUE_TRUNCATE_BYTES = 64 * 1024;
const KEY_TYPES_BATCH_MAX = 200;
// Mirrors REDIS_DB_INDEX_MAX in domain/models/database.ts (renderer side; this
// file is plain CJS and cannot import TS): `databases` is server config and 16
// is only the default, so SELECT must accept indexes beyond the default.
const REDIS_DB_INDEX_MAX = 65535;
const PUBSUB_PUSH_CHANNEL = "quolldesk:redis:pubsubMessage";
// Console-executed commands that would wedge the shared connection or desync
// the workbench state — the Subscribe page covers pub/sub properly.
const CONSOLE_BLOCKED_COMMANDS = new Set([
  "SUBSCRIBE", "PSUBSCRIBE", "UNSUBSCRIBE", "PUNSUBSCRIBE",
  "SSUBSCRIBE", "SUNSUBSCRIBE", "RESET", "SELECT",
]);

// Per-connection ipc sender for pub/sub pushes. Entries are removed when the
// connection closes (user disconnect, idle reap, renderer gone) so a dead
// renderer's WebContents is not kept alive.
const pubsubByConnection = new Map();

/** Quote-aware command line tokenizer: INFO server / GET "my key" / HSET k f 'v'. */
function splitCommandLine(line) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(String(line))) !== null) {
    tokens.push(match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3]);
  }
  return tokens;
}

function serializeReply(reply, depth = 0) {
  if (reply == null) return null;
  if (typeof reply === "bigint") return reply.toString();
  if (Buffer.isBuffer(reply)) {
    const text = reply.toString("utf8");
    return text.length > 4096 ? `${text.slice(0, 4096)}…(+${reply.length - 4096}B)` : text;
  }
  if (Array.isArray(reply)) {
    if (depth >= 6) return ["…"];
    return reply.map((item) => serializeReply(item, depth + 1));
  }
  if (typeof reply === "object") {
    try { return JSON.parse(JSON.stringify(reply)); } catch { return String(reply); }
  }
  if (typeof reply === "string" && reply.length > 65536) return `${reply.slice(0, 65536)}…(truncated)`;
  return reply;
}

let driver = require("redis");
function _setDriverForTests(next) { driver = next ?? require("redis"); }

const VALUE_PAGE_SIZE = 200;

/**
 * Local loopback forwarder for plain-TCP tunnel sockets: node-redis v4 socket
 * options only accept net.connect()/tls.connect() options (no pre-existing
 * duplex, see @redis/client socket.js), so we hand the client a local port
 * that pipes into the SSH tunnel socket. Auto-reconnect is disabled for
 * tunneled dials because the upstream duplex is single-use.
 */
function startTunnelForwarder(tunnelSocket) {
  const net = require("node:net");
  let upstream = tunnelSocket;
  const server = net.createServer((downstream) => {
    if (!upstream || upstream.destroyed) { downstream.destroy(); return; }
    const current = upstream;
    const teardown = () => {
      downstream.destroy();
      try { current.destroy(); } catch { /* ignore */ }
      if (upstream === current) upstream = null;
    };
    downstream.on("error", teardown);
    current.on("error", teardown);
    downstream.on("close", teardown);
    current.on("close", teardown);
    downstream.pipe(current);
    current.pipe(downstream);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.once("error", () => { try { server.close(); } catch { /* ignore */ } });
      resolve({
        port: server.address().port,
        close: () => { try { server.close(); } catch { /* ignore */ } },
      });
    });
  });
}

async function dialClient(opts) {
  const config = opts.config || {};
  const useCluster = config.cluster === true && Array.isArray(config.clusterNodes) && config.clusterNodes.length > 0;
  const auth = {
    username: config.redisUsername || undefined,
    password: opts.password || undefined,
  };

  if (useCluster) {
    const rootNodes = config.clusterNodes.map((n) => ({ socket: { host: n.hostname, port: n.port }, ...auth }));
    // defaults.socket merges UNDER each rootNodes socket (cluster-slots.js clientOptionsDefaults),
    // so reconnectStrategy:false survives per-node host/port overrides. Without it the default
    // retry loop makes connect() never settle and the IPC handler would never return an envelope.
    const cluster = driver.createCluster({
      rootNodes,
      defaults: { ...auth, socket: { reconnectStrategy: false } },
    });
    // The cluster re-emits node socket errors on itself; an emission with no listener throws.
    cluster.on?.("error", (err) => console.warn("[redisBridge] client error:", err?.code || err?.message));
    await cluster.connect();
    return { kind: "cluster", client: cluster };
  }

  const clientOptions = { ...auth };
  if (typeof config.redisDb === "number") clientOptions.database = config.redisDb;

  if (opts.tunnel?.socket) {
    if (config.tls === true) {
      // node-redis natively wraps an existing duplex when tls:true (tls.connect({ socket, servername })).
      clientOptions.socket = {
        tls: true,
        socket: opts.tunnel.socket,
        servername: opts.hostname || undefined,
        rejectUnauthorized: !config.tlsInsecure,
        reconnectStrategy: false,
      };
      const client = driver.createClient(clientOptions);
      client.on?.("error", (err) => console.warn("[redisBridge] client error:", err?.code || err?.message));
      await client.connect();
      return { kind: "single", client };
    }
    // Plain tunnel: forward through a loopback listener (single-use upstream).
    let forwarder = null;
    try {
      forwarder = await startTunnelForwarder(opts.tunnel.socket);
      clientOptions.socket = { host: "127.0.0.1", port: forwarder.port, reconnectStrategy: false };
      const client = driver.createClient(clientOptions);
      client.on?.("error", (err) => console.warn("[redisBridge] client error:", err?.code || err?.message));
      await client.connect();
      return { kind: "single", client, forwarder };
    } catch (err) {
      try { forwarder?.close(); } catch { /* ignore */ }
      throw err;
    }
  }

  // reconnectStrategy:false: the default retry loop keeps connect() pending forever
  // on unreachable hosts; failing fast lets the handler return an error envelope.
  clientOptions.socket = { host: opts.hostname, port: opts.port, reconnectStrategy: false };
  if (config.tls === true) {
    clientOptions.socket.tls = true;
    clientOptions.socket.rejectUnauthorized = !config.tlsInsecure;
  }
  const client = driver.createClient(clientOptions);
  client.on?.("error", (err) => console.warn("[redisBridge] client error:", err?.code || err?.message));
  await client.connect();
  return { kind: "single", client };
}

/** Idempotent, never throws: stop forwarder, quit gracefully or force-disconnect. */
async function closeDial(dial) {
  if (!dial) return;
  try { dial.forwarder?.close(); } catch { /* ignore */ }
  const client = dial.client;
  if (!client) return;
  try {
    await client.quit?.();
  } catch {
    try { await client.disconnect?.(); } catch { /* ignore */ }
  }
}

/** Cluster masters getter (v4.7.1) with getMasters() fallback. */
function clusterMasters(cluster) {
  const masters = typeof cluster.masters !== "undefined" ? cluster.masters : null;
  if (Array.isArray(masters)) return masters;
  if (typeof cluster.getMasters === "function") return cluster.getMasters();
  return [];
}

/**
 * Resolve the underlying node client for a key operation (cluster-aware).
 * `nodeId` is matched against `cluster.masters[].id` (ShardNode), since v4's
 * nodeClient(node) takes a ShardNode object rather than a bare id.
 */
async function nodeFor(dial, nodeId) {
  const cluster = dial?.client;
  if (!cluster || dial.kind !== "cluster") return cluster;
  if (!nodeId) return cluster; // cluster-level client routes keys automatically
  const node = clusterMasters(cluster).find((m) => m?.id === nodeId);
  if (!node) return cluster;
  return await cluster.nodeClient(node);
}

/** ZRANGE ... WITHSCORES: v4 method is zRangeWithScores -> Array<ZMember>. */
async function zrangeWithScoresPairs(client, key, start, stop) {
  const members = await client.zRangeWithScores(key, start, stop);
  return (members || []).map((m) => [m.value, Number(m.score)]);
}

/** Key-management params are all non-empty strings. */
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

/**
 * One key-management handler skeleton: resolve entry → validate params →
 * touch → cluster nodeFor → run → envelope. `validate(params)` returns the
 * INVALID_PARAMS message when params are bad; `run(client, params)` performs
 * the op and returns the okEnvelope data (or a complete error envelope, e.g.
 * createKey's duplicate check).
 */
function registerKeyOp(ipcMain, channel, { validate, run }) {
  const label = channel.slice(channel.lastIndexOf(":") + 1);
  ipcMain.handle(channel, async (_event, params = {}) => {
    const entry = registry.getConnection(params.connectionId);
    if (!entry) return errorEnvelope(DB_ERROR_CODES.NOT_CONNECTED, "not connected");
    const invalid = validate(params);
    if (invalid) return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, invalid);
    registry.touchConnection(params.connectionId);
    try {
      const client = await nodeFor(entry.client, params.nodeId);
      const result = await run(client, params);
      return result && typeof result.ok === "boolean" ? result : okEnvelope(result ?? {});
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || `${label} failed`);
    }
  });
}

// Key-management writes (cluster routes plain key commands automatically).
const requires = (message, ...checks) => (params) =>
  checks.every((check) => check(params)) ? null : message;
const keyAndString = (params) => isNonEmptyString(params.key) && typeof params.value === "string";
const keyAndField = (params) => isNonEmptyString(params.key) && isNonEmptyString(params.field);
const keyAndMember = (params) => isNonEmptyString(params.key) && isNonEmptyString(params.member);

const KEY_OPS = [
  {
    channel: "quolldesk:redis:createKey",
    validate: requires("key and string value are required", keyAndString),
    run: async (client, { key, value }) => {
      if ((await client.exists(key)) > 0) {
        return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, "key already exists");
      }
      await client.set(key, value);
      return { key };
    },
  },
  {
    channel: "quolldesk:redis:deleteKey",
    validate: requires("key required", (p) => isNonEmptyString(p.key)),
    run: async (client, { key }) => { await client.del(key); return { key }; },
  },
  {
    channel: "quolldesk:redis:renameKey",
    // Driver errors surface normally (e.g. RENAME onto an existing key fails server-side).
    validate: requires("key and newKey are required", (p) => isNonEmptyString(p.key) && isNonEmptyString(p.newKey)),
    run: async (client, { key, newKey }) => { await client.rename(key, newKey); return { key: newKey }; },
  },
  {
    // ttlSeconds: positive integer -> EXPIRE; explicit null -> PERSIST.
    channel: "quolldesk:redis:expireKey",
    validate: requires("key and a positive integer ttlSeconds (or null) are required", ({ key, ttlSeconds }) => (
      isNonEmptyString(key) && (ttlSeconds === null || (Number.isInteger(ttlSeconds) && ttlSeconds > 0))
    )),
    run: async (client, { key, ttlSeconds }) => {
      if (ttlSeconds === null) await client.persist(key);
      else await client.expire(key, ttlSeconds);
      return { ttlSeconds };
    },
  },
  {
    // SET with KEEPTTL: replaces the value while keeping the current TTL
    // (node-redis v4 supports the KEEPTTL option, see @redis/client SET.d.ts).
    channel: "quolldesk:redis:setStringValue",
    validate: requires("key and string value are required", keyAndString),
    run: async (client, { key, value }) => {
      await client.set(key, value, { KEEPTTL: true });
      return { key };
    },
  },
  {
    channel: "quolldesk:redis:hashSetField",
    validate: requires("key, field and string value are required", keyAndField, (p) => typeof p.value === "string"),
    run: async (client, { key, field, value }) => { await client.hSet(key, field, value); return {}; },
  },
  {
    channel: "quolldesk:redis:hashDeleteField",
    validate: requires("key and field are required", keyAndField),
    run: async (client, { key, field }) => { await client.hDel(key, field); return {}; },
  },
  {
    channel: "quolldesk:redis:listPush",
    validate: requires("key, position ('left'|'right') and string value are required", ({ key, position = "right", value }) => (
      isNonEmptyString(key) && (position === "left" || position === "right") && typeof value === "string"
    )),
    run: async (client, { key, position, value }) => {
      await (position === "left" ? client.lPush(key, value) : client.rPush(key, value));
      return {};
    },
  },
  {
    // LREM count 1: drop the first occurrence scanning from the head.
    channel: "quolldesk:redis:listRemoveValue",
    validate: requires("key and value are required", (p) => isNonEmptyString(p.key) && isNonEmptyString(p.value)),
    run: async (client, { key, value }) => { await client.lRem(key, 1, value); return {}; },
  },
  {
    channel: "quolldesk:redis:setAddMember",
    validate: requires("key and member are required", keyAndMember),
    run: async (client, { key, member }) => { await client.sAdd(key, member); return {}; },
  },
  {
    channel: "quolldesk:redis:setRemoveMember",
    validate: requires("key and member are required", keyAndMember),
    run: async (client, { key, member }) => { await client.sRem(key, member); return {}; },
  },
  {
    // ZADD member shape follows node-redis v4: ({ value, score }).
    channel: "quolldesk:redis:zsetAddMember",
    validate: requires("key, member and a finite score are required", ({ key, member, score }) => (
      isNonEmptyString(key) && isNonEmptyString(member) && typeof score === "number" && Number.isFinite(score)
    )),
    run: async (client, { key, member, score }) => {
      await client.zAdd(key, { value: member, score });
      return {};
    },
  },
  {
    channel: "quolldesk:redis:zsetRemoveMember",
    validate: requires("key and member are required", keyAndMember),
    run: async (client, { key, member }) => { await client.zRem(key, member); return {}; },
  },
];

function registerHandlers(ipcMain, options = {}) {
  ipcMain.handle("quolldesk:redis:connect", async (event, opts = {}) => {
    if (!opts.hostname || !Number.isInteger(opts.port)) {
      return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, "hostname and integer port are required");
    }
    let tunnel = null;
    try {
      if (opts.ssh) {
        // Unique per-attempt token: concurrent dials must not collide on the pool leaseId.
        tunnel = await openDbTunnel({
          event,
          ssh: opts.ssh,
          targetHost: opts.hostname,
          targetPort: opts.port,
          connectionId: randomUUID(),
        });
      }
      const dial = await dialClient({ ...opts, tunnel });
      const connectionId = registry.registerConnection({
        dialect: "redis",
        senderId: event.sender.id,
        client: dial,
        tunnel,
        meta: {
          hostname: opts.hostname,
          port: opts.port,
          database: opts.config?.database ?? opts.config?.redisDb ?? null,
          username: opts.username ?? opts.config?.redisUsername ?? null,
        },
        close: () => {
          pubsubByConnection.delete(connectionId);
          closeDial(dial);
          if (tunnel) tunnel.release();
        },
      });
      // reconnectStrategy:false means a lost socket never comes back — the
      // close must reach the renderer instead of stranding a green dot.
      watchDriverDeath(dial.client, connectionId, registry);
      return okEnvelope({ connectionId });
    } catch (err) {
      try { if (tunnel) tunnel.release(); } catch { /* ignore */ }
      return errorEnvelope(classifyDriverError(err), err?.message || "connect failed");
    }
  });

  ipcMain.handle("quolldesk:redis:disconnect", async (_event, { connectionId } = {}) => {
    if (!connectionId) return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, "connectionId required");
    registry.closeConnection(connectionId, "user");
    return okEnvelope({});
  });

  ipcMain.handle("quolldesk:redis:test", async (event, opts = {}) => {
    let tunnel = null;
    let dial = null;
    const started = Date.now();
    try {
      if (opts.ssh) {
        tunnel = await openDbTunnel({
          event,
          ssh: opts.ssh,
          targetHost: opts.hostname,
          targetPort: opts.port,
          connectionId: randomUUID(),
        });
      }
      dial = await dialClient({ ...opts, tunnel });
      const pong = await dial.client.ping();
      const info = await dial.client.info();
      const version = String(info).match(/redis_version:([^\r\n]+)/)?.[1] || "unknown";
      return okEnvelope({ latencyMs: Date.now() - started, pong: String(pong), serverVersion: version });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "test failed");
    } finally {
      await closeDial(dial);
      if (tunnel) tunnel.release();
    }
  });

  ipcMain.handle("quolldesk:redis:scan", async (_event, { connectionId, match, cursor = "0", count = SCAN_COUNT_DEFAULT, nodeId } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry) return errorEnvelope(DB_ERROR_CODES.NOT_CONNECTED, "not connected");
    registry.touchConnection(connectionId);
    try {
      const client = await nodeFor(entry.client, nodeId);
      const result = await client.scan(String(cursor), {
        MATCH: match && match.trim() ? `*${match.trim()}*` : undefined,
        COUNT: count,
      });
      const keys = (result?.keys || []).map((name) => ({ name, ...(nodeId ? { nodeId } : {}) }));
      return okEnvelope({ cursor: result.cursor, keys });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "scan failed");
    }
  });

  ipcMain.handle("quolldesk:redis:keyMeta", async (_event, { connectionId, key, nodeId } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry || !key) return errorEnvelope(entry ? DB_ERROR_CODES.INVALID_PARAMS : DB_ERROR_CODES.NOT_CONNECTED, entry ? "key required" : "not connected");
    registry.touchConnection(connectionId);
    try {
      const client = await nodeFor(entry.client, nodeId);
      const [type, ttlMs, sizeBytes] = await Promise.all([
        client.type(key),
        client.pTTL(key),
        client.memoryUsage(key).catch(() => null),
      ]);
      return okEnvelope({
        type: String(type),
        ttlMs: Number.isFinite(ttlMs) ? ttlMs : null,
        sizeBytes: sizeBytes == null ? null : Number(sizeBytes),
      });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "keyMeta failed");
    }
  });

  // Switch the connection's logical database (SELECT). Cluster mode has a
  // single keyspace and rejects the switch.
  ipcMain.handle("quolldesk:redis:selectDb", async (_event, { connectionId, db } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry) return errorEnvelope(DB_ERROR_CODES.NOT_CONNECTED, "not connected");
    if (!Number.isInteger(db) || db < 0 || db > REDIS_DB_INDEX_MAX) {
      return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, `db must be an integer 0-${REDIS_DB_INDEX_MAX}`);
    }
    if (entry.client.kind === "cluster") {
      return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, "cluster mode has a single keyspace; db selection is not supported");
    }
    registry.touchConnection(connectionId);
    try {
      const client = await nodeFor(entry.client);
      await client.select(db);
      return okEnvelope({ db });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "select failed");
    }
  });

  // Batch TYPE lookup for a scan page (drives the key-list type badges).
  // Concurrent commands on one node-redis connection are auto-pipelined.
  ipcMain.handle("quolldesk:redis:keyTypes", async (_event, { connectionId, keys, nodeId } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry) return errorEnvelope(DB_ERROR_CODES.NOT_CONNECTED, "not connected");
    if (!Array.isArray(keys) || keys.length === 0) return okEnvelope({ types: {} });
    const capped = keys.slice(0, KEY_TYPES_BATCH_MAX);
    registry.touchConnection(connectionId);
    try {
      const client = await nodeFor(entry.client, nodeId);
      const types = await Promise.all(capped.map((key) => client.type(key).catch(() => "none")));
      const out = {};
      capped.forEach((key, i) => { out[key] = String(types[i]); });
      return okEnvelope({ types: out });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "keyTypes failed");
    }
  });

  // Pub/sub: subscribe/unsubscribe on the shared client; messages are pushed
  // to the subscribing renderer over quolldesk:redis:pubsubMessage.
  ipcMain.handle("quolldesk:redis:subscribe", async (event, { connectionId, channel, pattern = false } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry || !channel || typeof channel !== "string") {
      return errorEnvelope(entry ? DB_ERROR_CODES.INVALID_PARAMS : DB_ERROR_CODES.NOT_CONNECTED, entry ? "channel required" : "not connected");
    }
    registry.touchConnection(connectionId);
    try {
      const client = entry.client.client;
      // subscribe listener: (message, channel); pSubscribe listener: (message, pattern, channel)
      const listener = (message, a, b) => {
        const pubsubEntry = pubsubByConnection.get(connectionId);
        const sender = pubsubEntry?.sender;
        if (!sender || sender.isDestroyed?.()) return;
        try {
          sender.send(PUBSUB_PUSH_CHANNEL, {
            connectionId,
            channel: pattern ? (b ?? a ?? channel) : (a ?? channel),
            pattern: pattern ? (a ?? channel) : null,
            message: typeof message === "string" ? message : String(message),
            receivedAt: Date.now(),
          });
        } catch { /* ignore push failures */ }
      };
      if (pattern) await client.pSubscribe(channel, listener);
      else await client.subscribe(channel, listener);
      pubsubByConnection.set(connectionId, { sender: event.sender, senderId: event.sender.id });
      return okEnvelope({ channel, pattern });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "subscribe failed");
    }
  });

  ipcMain.handle("quolldesk:redis:unsubscribe", async (_event, { connectionId, channel, pattern = false } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry || !channel || typeof channel !== "string") {
      return errorEnvelope(entry ? DB_ERROR_CODES.INVALID_PARAMS : DB_ERROR_CODES.NOT_CONNECTED, entry ? "channel required" : "not connected");
    }
    registry.touchConnection(connectionId);
    try {
      const client = entry.client.client;
      if (pattern) await client.pUnsubscribe(channel);
      else await client.unsubscribe(channel);
      return okEnvelope({ channel, pattern });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "unsubscribe failed");
    }
  });

  // Console: run an arbitrary command (parsed quote-aware). Subscribe-family
  // and state-resetting commands are rejected — those belong to dedicated UI.
  ipcMain.handle("quolldesk:redis:runCommand", async (_event, { connectionId, command } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry || !command || !String(command).trim()) {
      return errorEnvelope(entry ? DB_ERROR_CODES.INVALID_PARAMS : DB_ERROR_CODES.NOT_CONNECTED, entry ? "command required" : "not connected");
    }
    registry.touchConnection(connectionId);
    const tokens = splitCommandLine(command);
    if (tokens.length === 0) return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, "empty command");
    const head = String(tokens[0]).toUpperCase();
    if (CONSOLE_BLOCKED_COMMANDS.has(head)) {
      return errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, `${head} is not available here — use the Subscribe page for pub/sub and the db selector for SELECT`);
    }
    try {
      const client = await nodeFor(entry.client);
      const reply = await client.sendCommand(tokens);
      return okEnvelope({ command: tokens.join(" "), reply: serializeReply(reply) });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "command failed");
    }
  });

  ipcMain.handle("quolldesk:redis:keyValue", async (_event, { connectionId, key, type, cursor = 0, count = VALUE_PAGE_SIZE, nodeId } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry || !key) return errorEnvelope(entry ? DB_ERROR_CODES.INVALID_PARAMS : DB_ERROR_CODES.NOT_CONNECTED, entry ? "key required" : "not connected");
    registry.touchConnection(connectionId);
    try {
      const client = await nodeFor(entry.client, nodeId);
      /** 64KB clip; `truncated` comes ONLY from this clip, never from paging. */
      const clip = (value) => {
        const text = typeof value === "string" ? value : JSON.stringify(value);
        if (text == null) return { value: null, truncated: false };
        if (Buffer.byteLength(text, "utf8") > VALUE_TRUNCATE_BYTES) {
          return { value: Buffer.from(text, "utf8").subarray(0, VALUE_TRUNCATE_BYTES).toString("utf8"), truncated: true };
        }
        return { value: text, truncated: false };
      };
      if (type === "string") {
        const raw = await client.get(key);
        const { value, truncated } = clip(raw == null ? null : String(raw));
        return okEnvelope({ items: [{ index: 0, value }], truncated });
      }
      // Hash/set pages stream from the server via HSCAN/SSCAN — fetching the
      // whole collection (HGETALL/SMEMBERS) just to serve one page would load
      // every field/member into the main process on every page view. The
      // cursor is the redis scan cursor; "0" ends the iteration.
      if (type === "hash") {
        const page = await client.hScan(key, String(Number(cursor) || 0), { COUNT: count });
        let truncated = false;
        const items = (page.tuples || []).map(({ field, value }) => {
          const clipped = clip(value);
          truncated = truncated || clipped.truncated;
          return { index: field, value: clipped.value };
        });
        const next = String(page.cursor ?? "0");
        return okEnvelope({ items, cursor: next, hasMore: next !== "0", truncated });
      }
      if (type === "list") {
        const start = Number(cursor);
        const page = await client.lRange(key, start, start + count - 1);
        let truncated = false;
        const items = (page || []).map((value, i) => {
          const clipped = clip(value);
          truncated = truncated || clipped.truncated;
          return { index: start + i, value: clipped.value };
        });
        return okEnvelope({
          items,
          cursor: start + items.length,
          hasMore: items.length === count,
          truncated,
        });
      }
      if (type === "set") {
        const page = await client.sScan(key, String(Number(cursor) || 0), { COUNT: count });
        const members = page.members || [];
        let truncated = false;
        const items = members.map((value, i) => {
          const clipped = clip(value);
          truncated = truncated || clipped.truncated;
          return { index: Number(cursor) + i, value: clipped.value };
        });
        const next = String(page.cursor ?? "0");
        return okEnvelope({ items, cursor: next, hasMore: next !== "0", truncated });
      }
      if (type === "zset") {
        const start = Number(cursor);
        const pairs = await zrangeWithScoresPairs(client, key, start, start + count - 1);
        let truncated = false;
        const items = pairs.map(([member, score], i) => {
          const clipped = clip(member);
          truncated = truncated || clipped.truncated;
          return { index: start + i, value: clipped.value, score };
        });
        return okEnvelope({ items, cursor: start + items.length, hasMore: items.length === count, truncated });
      }
      // stream and unknown types: graceful note, no raw dump in v1
      return okEnvelope({ items: [], cursor: 0, hasMore: false, truncated: false, note: "type preview not supported in v1" });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "keyValue failed");
    }
  });

  // ---- Key management (writes; see KEY_OPS above) ----
  for (const op of KEY_OPS) registerKeyOp(ipcMain, op.channel, op);

  ipcMain.handle("quolldesk:redis:serverInfo", async (_event, { connectionId, nodeId } = {}) => {
    const entry = registry.getConnection(connectionId);
    if (!entry) return errorEnvelope(DB_ERROR_CODES.NOT_CONNECTED, "not connected");
    try {
      const client = await nodeFor(entry.client, nodeId);
      const info = await client.info();
      const summary = {};
      for (const line of String(info).split(/\r?\n/)) {
        if (!line || line.startsWith("#")) continue;
        const idx = line.indexOf(":");
        if (idx > 0) summary[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      // Server-configured logical-DB count for the workbench db selector
      // (INFO's `databases` line is absent on many Redis builds and the
      // flattened summary carries no section prefixes). Some managed
      // providers disable CONFIG entirely — absence means the renderer falls
      // back to the 16-db default.
      let databases;
      try {
        const cfg = await client.configGet("databases");
        const parsed = Number(cfg?.databases);
        if (Number.isInteger(parsed) && parsed >= 1) databases = parsed;
      } catch { /* CONFIG disabled on this provider */ }
      let nodes;
      if (entry.client.kind === "cluster") {
        nodes = clusterMasters(entry.client.client).map((m) => ({
          nodeId: String(m.id || ""),
          host: String(m.host || m.ip || ""),
          port: Number(m.port || 0),
          role: "master",
        }));
      }
      return okEnvelope({ summary, nodes, databases });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "serverInfo failed");
    }
  });
}

function closeAllForSender(senderId) { return registry.closeAllForSender(senderId); }

module.exports = {
  registerHandlers,
  closeAllForSender,
  _setDriverForTests,
  // exported for the capability service (database AI/MCP tools)
  splitCommandLine,
  serializeReply,
  CONSOLE_BLOCKED_COMMANDS,
  nodeFor,
};
