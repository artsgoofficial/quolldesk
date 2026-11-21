const test = require("node:test");
const assert = require("node:assert/strict");
const registry = require("./connectionRegistry.cjs");

function makeEntry(overrides = {}) {
  const closed = [];
  return {
    closed,
    entry: {
      dialect: "redis",
      senderId: 1,
      client: { id: "client" },
      tunnel: null,
      close: (reason) => closed.push(reason),
      ...overrides,
    },
  };
}

test("register/get/touch round trip", () => {
  registry._resetForTests();
  const { entry } = makeEntry();
  const id = registry.registerConnection(entry);
  assert.equal(registry.getConnection(id)?.dialect, "redis");
  assert.ok(registry.touchConnection(id));
  registry.closeConnection(id, "test");
  assert.equal(registry.getConnection(id), undefined);
});

test("close is idempotent and calls entry.close once", () => {
  registry._resetForTests();
  const { entry, closed } = makeEntry();
  const id = registry.registerConnection(entry);
  registry.closeConnection(id, "a");
  registry.closeConnection(id, "b");
  assert.deepEqual(closed, ["a"]);
});

test("closeAllForSender only closes that sender", () => {
  registry._resetForTests();
  const a = makeEntry({ senderId: 1 });
  const b = makeEntry({ senderId: 2 });
  const idA = registry.registerConnection(a.entry);
  const idB = registry.registerConnection(b.entry);
  assert.equal(registry.closeAllForSender(1), 1);
  assert.equal(registry.getConnection(idA), undefined);
  assert.ok(registry.getConnection(idB));
  registry.closeConnection(idB, "cleanup");
});

test("idle timer reaps inactive connections", async () => {
  registry._resetForTests();
  const closed = [];
  const id = registry.registerConnection({
    dialect: "mysql", senderId: 1, client: {}, tunnel: null,
    close: (r) => closed.push(r),
  });
  registry.setIdleTimeoutMs(20);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(registry.getConnection(id), undefined);
  assert.deepEqual(closed, ["idle-timeout"]);
  registry.setIdleTimeoutMs(10 * 60_000);
});

test("close listener fires with entry + reason on explicit close", () => {
  registry._resetForTests();
  const seen = [];
  registry.setCloseListener((entry, reason) => seen.push({ id: entry.id, reason }));
  const id = registry.registerConnection({
    dialect: "postgresql", senderId: 7, client: {}, tunnel: null, close() {},
  });
  registry.closeConnection(id, "idle-timeout");
  assert.deepEqual(seen, [{ id, reason: "idle-timeout" }]);
  registry.setCloseListener(null);
});

test("close listener fires on idle-timer reap", async () => {
  registry._resetForTests();
  const seen = [];
  registry.setCloseListener((entry, reason) => seen.push({ id: entry.id, reason }));
  const id = registry.registerConnection({
    dialect: "mysql", senderId: 1, client: {}, tunnel: null, close() {},
  });
  registry.setIdleTimeoutMs(20);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(seen, [{ id, reason: "idle-timeout" }]);
  registry.setIdleTimeoutMs(10 * 60_000);
  registry.setCloseListener(null);
});

test("close listener failure does not break closeConnection", () => {
  registry._resetForTests();
  registry.setCloseListener(() => { throw new Error("listener boom"); });
  const id = registry.registerConnection({
    dialect: "redis", senderId: 1, client: {}, tunnel: null, close() {},
  });
  assert.equal(registry.closeConnection(id, "driver-error"), true);
  assert.equal(registry.getConnection(id), undefined);
  registry.setCloseListener(null);
});

test("setCloseListener(null) clears the listener", () => {
  registry._resetForTests();
  const seen = [];
  registry.setCloseListener((entry, reason) => seen.push(reason));
  registry.setCloseListener(null);
  const id = registry.registerConnection({
    dialect: "redis", senderId: 1, client: {}, tunnel: null, close() {},
  });
  registry.closeConnection(id, "user");
  assert.deepEqual(seen, []);
});

test("registerConnection stores meta and listConnections exposes it without clients", () => {
  registry._resetForTests();
  const id = registry.registerConnection({
    dialect: "mysql",
    senderId: 1,
    client: { conn: {} },
    close() {},
    meta: { hostname: "db.local", port: 3306, database: "shop", username: "app" },
  });
  const listed = registry.listConnections();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, id);
  assert.equal(listed[0].dialect, "mysql");
  assert.deepEqual(listed[0].meta, { hostname: "db.local", port: 3306, database: "shop", username: "app" });
  assert.ok(!("client" in listed[0]) && !("close" in listed[0]) && !("tunnel" in listed[0]));
});
