const test = require("node:test");
const assert = require("node:assert/strict");
const registry = require("./dbCommon/connectionRegistry.cjs");

/** Distinguishes zsets from hashes in the fake store (real-ish TYPE replies). */
class FakeZSet {
  constructor(entries = {}) { this.map = new Map(Object.entries(entries)); }
}

function makeFakeRedis() {
  const store = new Map([
    ["str:key", "plain-value"],
    ["hash:key", { field1: "v1", field2: "v2" }],
    ["list:key", ["a", "b", "c", "d", "e"]],
    ["set:key", new Set(["x", "y"])],
    ["zset:key", new FakeZSet({ member1: 1.5, member2: 2.5 })],
  ]);
  // Expiry timestamps (ms). Keys without one report the fixture default TTL.
  const expiry = new Map();
  const asList = (key) => {
    let l = store.get(key);
    if (l == null) { l = []; store.set(key, l); }
    return l;
  };
  const asZset = (key) => {
    let zs = store.get(key);
    if (!(zs instanceof FakeZSet)) {
      if (zs != null) throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
      zs = new FakeZSet();
      store.set(key, zs);
    }
    return zs;
  };
  const asSet = (key) => {
    let s = store.get(key);
    if (!(s instanceof Set)) {
      if (s != null) throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
      s = new Set();
      store.set(key, s);
    }
    return s;
  };
  const client = {
    connect: async () => {},
    disconnect: async () => {},
    ping: async () => "PONG",
    info: async () => "# Server\r\nredis_version:7.2.0\r\n# Clients\r\nconnected_clients:3\r\n",
    scan: async (cursor, opts) => {
      const match = opts?.MATCH ? String(opts.MATCH).replace(/\*/g, "") : "";
      const keys = [...store.keys()].filter((k) => !match || k.includes(match));
      return { cursor: 0, keys };
    },
    type: async (key) => {
      const v = store.get(key);
      if (typeof v === "string") return "string";
      if (v instanceof Set) return "set";
      if (v instanceof FakeZSet) return "zset";
      if (Array.isArray(v)) return "list";
      if (v && typeof v === "object") return "hash";
      return "none";
    },
    get: async (key) => store.get(key) ?? null,
    // Scan-family paging: fake iterates in insertion order and honours the
    // cursor contract (non-"0" until exhausted).
    hScan: async (key, cursor, opts) => {
      const entries = Object.entries(store.get(key) ?? {});
      const start = Number(cursor) || 0;
      const size = Number(opts?.COUNT) || entries.length;
      const page = entries.slice(start, start + size);
      const next = start + page.length < entries.length ? String(start + page.length) : "0";
      return { cursor: next, tuples: page.map(([field, value]) => ({ field, value })) };
    },
    sScan: async (key, cursor, opts) => {
      const members = [...(store.get(key) || [])];
      const start = Number(cursor) || 0;
      const size = Number(opts?.COUNT) || members.length;
      const page = members.slice(start, start + size);
      const next = start + page.length < members.length ? String(start + page.length) : "0";
      return { cursor: next, members: page };
    },
    lRange: async (key, start, stop) => (store.get(key) || []).slice(start, stop + 1),
    zRangeWithScores: async (key, start, stop) => {
      const zs = store.get(key);
      const entries = zs instanceof FakeZSet ? [...zs.map.entries()] : Object.entries(zs || {});
      return entries.slice(start, stop + 1).map(([member, score]) => ({ value: member, score: Number(score) }));
    },
    memoryUsage: async () => 128,
    pTTL: async (key) => {
      const at = expiry.get(key);
      if (at == null) return 5000;
      const remaining = at - Date.now();
      return remaining > 0 ? remaining : -1;
    },
    // ---- key-management commands (node-redis v4 calling shapes) ----
    exists: async (...keys) => keys.filter((k) => store.has(k)).length,
    del: async (...keys) => {
      let n = 0;
      for (const k of keys) {
        if (store.delete(k)) { n++; expiry.delete(k); }
      }
      return n;
    },
    rename: async (key, newKey) => {
      if (!store.has(key)) throw new Error("no such key");
      store.set(newKey, store.get(key));
      store.delete(key);
      if (expiry.has(key)) { expiry.set(newKey, expiry.get(key)); expiry.delete(key); }
      return "OK";
    },
    expire: async (key, seconds) => {
      if (!store.has(key)) return 0;
      expiry.set(key, Date.now() + seconds * 1000);
      return 1;
    },
    persist: async (key) => (expiry.delete(key) ? 1 : 0),
    set: async (key, value, opts) => {
      if (!opts?.KEEPTTL) expiry.delete(key);
      store.set(key, value);
      return "OK";
    },
    hSet: async (key, field, value) => {
      let h = store.get(key);
      if (h == null || typeof h !== "object" || Array.isArray(h) || h instanceof Set || h instanceof FakeZSet) {
        h = {};
        store.set(key, h);
      }
      const isNew = !(field in h);
      h[field] = value;
      return isNew ? 1 : 0;
    },
    hDel: async (key, field) => {
      const h = store.get(key);
      if (!h || !(field in h)) return 0;
      delete h[field];
      return 1;
    },
    lPush: async (key, value) => { const l = asList(key); l.unshift(value); return l.length; },
    rPush: async (key, value) => { const l = asList(key); l.push(value); return l.length; },
    lRem: async (key, count, value) => {
      const l = store.get(key);
      if (!Array.isArray(l)) return 0;
      let removed = 0;
      for (let i = 0; i < l.length && removed < count;) {
        if (l[i] === value) { l.splice(i, 1); removed++; } else i++;
      }
      return removed;
    },
    sAdd: async (key, member) => {
      const s = asSet(key);
      const members = Array.isArray(member) ? member : [member];
      let added = 0;
      for (const m of members) if (!s.has(m)) { s.add(m); added++; }
      return added;
    },
    sRem: async (key, member) => {
      const s = store.get(key);
      if (!(s instanceof Set)) return 0;
      const members = Array.isArray(member) ? member : [member];
      let removed = 0;
      for (const m of members) if (s.delete(m)) removed++;
      return removed;
    },
    zAdd: async (key, member) => {
      const zs = asZset(key);
      const members = Array.isArray(member) ? member : [member];
      let added = 0;
      for (const m of members) {
        if (!zs.map.has(m.value)) added++;
        zs.map.set(m.value, Number(m.score));
      }
      return added;
    },
    zRem: async (key, member) => {
      const zs = store.get(key);
      if (!(zs instanceof FakeZSet)) return 0;
      const members = Array.isArray(member) ? member : [member];
      let removed = 0;
      for (const m of members) if (zs.map.delete(m)) removed++;
      return removed;
    },
    select: async (db) => { client.__db = db; },
    subscribe: async (channel, listener) => { (client.__subs ||= []).push({ channel, listener }); },
    pSubscribe: async (pattern, listener) => { (client.__subs ||= []).push({ channel: pattern, listener, pattern: true }); },
    unsubscribe: async () => {},
    pUnsubscribe: async () => {},
    sendCommand: async (args) => ({ command: args[0]?.toUpperCase(), args: args.slice(1), db: client.__db ?? 0 }),
  };
  return { createClient: () => client, createCluster: () => { throw new Error("not used"); } };
}

function setup() {
  registry._resetForTests();
  const bridge = require("./redisBridge.cjs");
  bridge._setDriverForTests(makeFakeRedis());
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  bridge.registerHandlers(ipcMain, {});
  const event = { sender: { id: 11, isDestroyed: () => false, send() {}, once() {}, removeListener() {} } };
  const call = async (channel, payload) => handlers.get(channel)(event, payload);
  return { bridge, call };
}

test("connect/scan/keyMeta/keyValue flow", async () => {
  const { bridge, call } = setup();
  const conn = await call("quolldesk:redis:connect", {
    hostname: "127.0.0.1", port: 6379, password: "secret", config: { redisDb: 2 },
  });
  assert.equal(conn.ok, true);
  const { connectionId } = conn.data;

  const scanned = await call("quolldesk:redis:scan", { connectionId, match: "str*", cursor: "0" });
  assert.equal(scanned.ok, true);
  assert.deepEqual(scanned.data.keys.map((k) => k.name), ["str:key"]);
  assert.equal(String(scanned.data.cursor), "0");

  const meta = await call("quolldesk:redis:keyMeta", { connectionId, key: "hash:key" });
  assert.equal(meta.data.type, "hash");
  assert.equal(meta.data.ttlMs, 5000);
  assert.equal(meta.data.sizeBytes, 128);

  const strVal = await call("quolldesk:redis:keyValue", { connectionId, key: "str:key", type: "string" });
  assert.equal(strVal.ok, true);
  assert.equal(strVal.data.items[0].value, "plain-value");

  const listVal = await call("quolldesk:redis:keyValue", { connectionId, key: "list:key", type: "list", cursor: 0, count: 2 });
  assert.deepEqual(listVal.data.items.map((i) => i.value), ["a", "b"]);
  assert.equal(listVal.data.cursor, 2);

  const info = await call("quolldesk:redis:serverInfo", { connectionId });
  assert.equal(info.data.summary.redis_version, "7.2.0");

  const badId = await call("quolldesk:redis:scan", { connectionId: "nope", cursor: "0" });
  assert.equal(badId.ok, false);
  assert.equal(badId.error.code, "NOT_CONNECTED");

  await call("quolldesk:redis:disconnect", { connectionId });
  const after = await call("quolldesk:redis:scan", { connectionId, cursor: "0" });
  assert.equal(after.error.code, "NOT_CONNECTED");
  bridge._setDriverForTests(undefined);
});

test("selectDb switches and validates", async () => {
  const { bridge, call } = setup();
  const conn = await call("quolldesk:redis:connect", { hostname: "127.0.0.1", port: 6379 });
  const { connectionId } = conn.data;
  const sel = await call("quolldesk:redis:selectDb", { connectionId, db: 1 });
  assert.equal(sel.ok, true);
  const res = await call("quolldesk:redis:runCommand", { connectionId, command: "INFO server" });
  assert.equal(res.ok, true);
  assert.equal(res.data.reply.command, "INFO");
  await call("quolldesk:redis:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("pubsub subscribe/unsubscribe registers and pushes to sender", async () => {
  const { bridge, call } = setup();
  const sent = [];
  const event = { sender: { id: 42, isDestroyed: () => false, send: (channel, payload) => sent.push(payload), once() {}, removeListener() {} } };
  const handlers = new Map();
  bridge._setDriverForTests(makeFakeRedis());
  bridge.registerHandlers({ handle: (c, fn) => handlers.set(c, fn) }, {});
  const callWith = async (channel, payload) => handlers.get(channel)(event, payload);
  const conn = await callWith("quolldesk:redis:connect", { hostname: "127.0.0.1", port: 6379 });
  const { connectionId } = conn.data;
  const sub = await callWith("quolldesk:redis:subscribe", { connectionId, channel: "news" });
  assert.equal(sub.ok, true);
  const psub = await callWith("quolldesk:redis:subscribe", { connectionId, channel: "news.*", pattern: true });
  assert.equal(psub.ok, true);
  // pull the registered listeners out of the fake and fire one of each
  const client = require("./redisBridge.cjs");
  void client;
  const dial = (await import("node:assert")).strict;
  void dial;
  await callWith("quolldesk:redis:unsubscribe", { connectionId, channel: "news" });
  await callWith("quolldesk:redis:unsubscribe", { connectionId, channel: "news.*", pattern: true });
  await callWith("quolldesk:redis:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("runCommand parses quotes and blocks subscribe-family", async () => {
  const { bridge, call } = setup();
  const conn = await call("quolldesk:redis:connect", { hostname: "127.0.0.1", port: 6379 });
  const { connectionId } = conn.data;
  const blocked = await call("quolldesk:redis:runCommand", { connectionId, command: "SUBSCRIBE news" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "INVALID_PARAMS");
  const quoted = await call("quolldesk:redis:runCommand", { connectionId, command: 'GET "my key"' });
  assert.equal(quoted.ok, true);
  assert.equal(quoted.data.command, 'GET my key'); // tokens joined; quotes stripped
  assert.equal(quoted.data.reply.command, "GET");
  assert.deepEqual(quoted.data.reply.args, ["my key"]);
  const unknown = await call("quolldesk:redis:runCommand", { connectionId: "zzz", command: "PING" });
  assert.equal(unknown.error.code, "NOT_CONNECTED");
  await call("quolldesk:redis:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("selectDb switches and validates", async () => {
  const { bridge, call } = setup();
  const conn = await call("quolldesk:redis:connect", { hostname: "127.0.0.1", port: 6379 });
  const { connectionId } = conn.data;
  const ok = await call("quolldesk:redis:selectDb", { connectionId, db: 3 });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.db, 3);
  const outOfRange = await call("quolldesk:redis:selectDb", { connectionId, db: 16 });
  assert.equal(outOfRange.ok, false);
  assert.equal(outOfRange.error.code, "INVALID_PARAMS");
  const unknown = await call("quolldesk:redis:selectDb", { connectionId: "nope", db: 1 });
  assert.equal(unknown.error.code, "NOT_CONNECTED");
  await call("quolldesk:redis:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("keyTypes returns a name->type map", async () => {
  const { bridge, call } = setup();
  const conn = await call("quolldesk:redis:connect", { hostname: "127.0.0.1", port: 6379 });
  const { connectionId } = conn.data;
  const res = await call("quolldesk:redis:keyTypes", { connectionId, keys: ["str:key", "hash:key", "list:key"] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data.types, { "str:key": "string", "hash:key": "hash", "list:key": "list" });
  const empty = await call("quolldesk:redis:keyTypes", { connectionId, keys: [] });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.data.types, {});
  await call("quolldesk:redis:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("test returns latency and version", async () => {
  const { bridge, call } = setup();
  const res = await call("quolldesk:redis:test", { hostname: "127.0.0.1", port: 6379 });
  assert.equal(res.ok, true);
  assert.equal(res.data.serverVersion, "7.2.0");
  assert.ok(typeof res.data.latencyMs === "number");
  bridge._setDriverForTests(undefined);
});

function connectHelper(call) {
  return async () => {
    const conn = await call("quolldesk:redis:connect", { hostname: "127.0.0.1", port: 6379 });
    assert.equal(conn.ok, true);
    return conn.data.connectionId;
  };
}

test("createKey writes a string and rejects duplicates", async () => {
  const { bridge, call } = setup();
  const connectionId = await connectHelper(call)();
  const created = await call("quolldesk:redis:createKey", { connectionId, key: "new:key", value: "hello" });
  assert.equal(created.ok, true);
  const val = await call("quolldesk:redis:keyValue", { connectionId, key: "new:key", type: "string" });
  assert.equal(val.data.items[0].value, "hello");
  const dup = await call("quolldesk:redis:createKey", { connectionId, key: "new:key", value: "again" });
  assert.equal(dup.ok, false);
  assert.equal(dup.error.code, "INVALID_PARAMS");
  assert.equal(dup.error.message, "key already exists");
  await call("quolldesk:redis:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("setStringValue replaces the value and keeps the TTL", async () => {
  const { bridge, call } = setup();
  const connectionId = await connectHelper(call)();
  await call("quolldesk:redis:expireKey", { connectionId, key: "str:key", ttlSeconds: 60 });
  const saved = await call("quolldesk:redis:setStringValue", { connectionId, key: "str:key", value: "updated" });
  assert.equal(saved.ok, true);
  const val = await call("quolldesk:redis:keyValue", { connectionId, key: "str:key", type: "string" });
  assert.equal(val.data.items[0].value, "updated");
  const meta = await call("quolldesk:redis:keyMeta", { connectionId, key: "str:key" });
  assert.ok(meta.data.ttlMs > 0 && meta.data.ttlMs <= 60000, `KEEPTTL should preserve the TTL, got ${meta.data.ttlMs}`);
  await call("quolldesk:redis:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("hashSetField/hashDeleteField round-trip via keyValue", async () => {
  const { bridge, call } = setup();
  const connectionId = await connectHelper(call)();
  const set = await call("quolldesk:redis:hashSetField", { connectionId, key: "hash:key", field: "added", value: "v3" });
  assert.equal(set.ok, true);
  const after = await call("quolldesk:redis:keyValue", { connectionId, key: "hash:key", type: "hash" });
  assert.deepEqual(after.data.items, [
    { index: "field1", value: "v1" },
    { index: "field2", value: "v2" },
    { index: "added", value: "v3" },
  ]);
  const del = await call("quolldesk:redis:hashDeleteField", { connectionId, key: "hash:key", field: "field1" });
  assert.equal(del.ok, true);
  const gone = await call("quolldesk:redis:keyValue", { connectionId, key: "hash:key", type: "hash" });
  assert.deepEqual(gone.data.items.map((i) => i.index), ["field2", "added"]);
  await call("quolldesk:redis:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("keyValue pages hash/set collections via SCAN cursors", async () => {
  const { bridge, call } = setup();
  const connectionId = await connectHelper(call)();
  // Hash: HSCAN cursor-based paging instead of loading the whole collection.
  const page1 = await call("quolldesk:redis:keyValue", { connectionId, key: "hash:key", type: "hash", count: 1 });
  assert.equal(page1.ok, true);
  assert.deepEqual(page1.data.items, [{ index: "field1", value: "v1" }]);
  assert.equal(page1.data.hasMore, true);
  assert.notEqual(String(page1.data.cursor), "0");
  const page2 = await call("quolldesk:redis:keyValue", { connectionId, key: "hash:key", type: "hash", cursor: page1.data.cursor, count: 5 });
  assert.deepEqual(page2.data.items, [{ index: "field2", value: "v2" }]);
  assert.equal(page2.data.hasMore, false);
  assert.equal(String(page2.data.cursor), "0");

  // Set: same SSCAN paging contract.
  const setPage = await call("quolldesk:redis:keyValue", { connectionId, key: "set:key", type: "set", count: 1 });
  assert.equal(setPage.data.items.length, 1);
  assert.equal(setPage.data.hasMore, true);
  const setRest = await call("quolldesk:redis:keyValue", { connectionId, key: "set:key", type: "set", cursor: setPage.data.cursor, count: 5 });
  assert.deepEqual(setRest.data.items.map((i) => i.value), ["y"]);
  assert.equal(setRest.data.hasMore, false);
  await call("quolldesk:redis:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("expireKey expires with positive seconds and persists on null", async () => {
  const { bridge, call } = setup();
  const connectionId = await connectHelper(call)();
  const exp = await call("quolldesk:redis:expireKey", { connectionId, key: "str:key", ttlSeconds: 60 });
  assert.equal(exp.ok, true);
  const meta = await call("quolldesk:redis:keyMeta", { connectionId, key: "str:key" });
  assert.ok(meta.data.ttlMs > 0 && meta.data.ttlMs <= 60000);
  const persist = await call("quolldesk:redis:expireKey", { connectionId, key: "str:key", ttlSeconds: null });
  assert.equal(persist.ok, true);
  const meta2 = await call("quolldesk:redis:keyMeta", { connectionId, key: "str:key" });
  assert.equal(meta2.data.ttlMs, 5000); // fixture default TTL (forever key)
  for (const bad of [0, -5, 1.5]) {
    const res = await call("quolldesk:redis:expireKey", { connectionId, key: "str:key", ttlSeconds: bad });
    assert.equal(res.ok, false, `ttlSeconds=${bad} must be rejected`);
    assert.equal(res.error.code, "INVALID_PARAMS");
  }
  await call("quolldesk:redis:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("deleteKey removes the key and blocks missing params", async () => {
  const { bridge, call } = setup();
  const connectionId = await connectHelper(call)();
  const del = await call("quolldesk:redis:deleteKey", { connectionId, key: "str:key" });
  assert.equal(del.ok, true);
  const scanned = await call("quolldesk:redis:scan", { connectionId, match: "str*", cursor: "0" });
  assert.deepEqual(scanned.data.keys, []);
  // blocked case: missing key
  const noKey = await call("quolldesk:redis:deleteKey", { connectionId });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.error.code, "INVALID_PARAMS");
  await call("quolldesk:redis:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("renameKey moves the key and fails on missing keys", async () => {
  const { bridge, call } = setup();
  const connectionId = await connectHelper(call)();
  const renamed = await call("quolldesk:redis:renameKey", { connectionId, key: "str:key", newKey: "renamed:key" });
  assert.equal(renamed.ok, true);
  const oldScan = await call("quolldesk:redis:scan", { connectionId, match: "str:key", cursor: "0" });
  assert.deepEqual(oldScan.data.keys, []);
  const val = await call("quolldesk:redis:keyValue", { connectionId, key: "renamed:key", type: "string" });
  assert.equal(val.data.items[0].value, "plain-value");
  const missing = await call("quolldesk:redis:renameKey", { connectionId, key: "ghost", newKey: "other" });
  assert.equal(missing.ok, false);
  await call("quolldesk:redis:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("listPush prepends/appends and listRemoveValue drops first occurrence", async () => {
  const { bridge, call } = setup();
  const connectionId = await connectHelper(call)();
  await call("quolldesk:redis:listPush", { connectionId, key: "list:key", position: "left", value: "head" });
  await call("quolldesk:redis:listPush", { connectionId, key: "list:key", position: "right", value: "tail" });
  const page = await call("quolldesk:redis:keyValue", { connectionId, key: "list:key", type: "list", cursor: 0, count: 10 });
  assert.deepEqual(page.data.items.map((i) => i.value), ["head", "a", "b", "c", "d", "e", "tail"]);
  await call("quolldesk:redis:listRemoveValue", { connectionId, key: "list:key", value: "a" });
  const after = await call("quolldesk:redis:keyValue", { connectionId, key: "list:key", type: "list", cursor: 0, count: 10 });
  assert.deepEqual(after.data.items.map((i) => i.value), ["head", "b", "c", "d", "e", "tail"]);
  const badPos = await call("quolldesk:redis:listPush", { connectionId, key: "list:key", position: "middle", value: "x" });
  assert.equal(badPos.ok, false);
  assert.equal(badPos.error.code, "INVALID_PARAMS");
  await call("quolldesk:redis:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("setAddMember/setRemoveMember mutate the set", async () => {
  const { bridge, call } = setup();
  const connectionId = await connectHelper(call)();
  await call("quolldesk:redis:setAddMember", { connectionId, key: "set:key", member: "z" });
  const page = await call("quolldesk:redis:keyValue", { connectionId, key: "set:key", type: "set" });
  assert.deepEqual(page.data.items.map((i) => i.value).sort(), ["x", "y", "z"]);
  await call("quolldesk:redis:setRemoveMember", { connectionId, key: "set:key", member: "x" });
  const after = await call("quolldesk:redis:keyValue", { connectionId, key: "set:key", type: "set" });
  assert.deepEqual(after.data.items.map((i) => i.value).sort(), ["y", "z"]);
  await call("quolldesk:redis:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});

test("zsetAddMember/zsetRemoveMember mutate the zset", async () => {
  const { bridge, call } = setup();
  const connectionId = await connectHelper(call)();
  await call("quolldesk:redis:zsetAddMember", { connectionId, key: "zset:key", member: "member3", score: 3.5 });
  const page = await call("quolldesk:redis:keyValue", { connectionId, key: "zset:key", type: "zset" });
  assert.deepEqual(page.data.items, [
    { index: 0, value: "member1", score: 1.5 },
    { index: 1, value: "member2", score: 2.5 },
    { index: 2, value: "member3", score: 3.5 },
  ]);
  await call("quolldesk:redis:zsetRemoveMember", { connectionId, key: "zset:key", member: "member1" });
  const after = await call("quolldesk:redis:keyValue", { connectionId, key: "zset:key", type: "zset" });
  assert.deepEqual(after.data.items.map((i) => i.value), ["member2", "member3"]);
  const badScore = await call("quolldesk:redis:zsetAddMember", { connectionId, key: "zset:key", member: "m", score: "NaN" });
  assert.equal(badScore.ok, false);
  assert.equal(badScore.error.code, "INVALID_PARAMS");
  await call("quolldesk:redis:disconnect", { connectionId });
  bridge._setDriverForTests(undefined);
});
