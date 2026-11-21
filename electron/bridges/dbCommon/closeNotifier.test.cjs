"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { installConnectionClosedPush, shouldNotifyRenderer } = require("./closeNotifier.cjs");

test("shouldNotifyRenderer: renderer-known reasons are filtered", () => {
  assert.equal(shouldNotifyRenderer("user"), false);
  assert.equal(shouldNotifyRenderer("renderer-gone"), false);
  assert.equal(shouldNotifyRenderer("test-reset"), false);
});

test("shouldNotifyRenderer: unexpected closes notify", () => {
  assert.equal(shouldNotifyRenderer("idle-timeout"), true);
  assert.equal(shouldNotifyRenderer("driver-error"), true);
  assert.equal(shouldNotifyRenderer("unknown-reason"), true);
  assert.equal(shouldNotifyRenderer(undefined), true);
});

function makeHarness() {
  const listeners = new Map();
  const sent = [];
  const contents = new Map([
    [11, { isDestroyed: () => false, send: (channel, payload) => sent.push({ senderId: 11, channel, payload }) }],
    [12, { isDestroyed: () => true, send: () => { throw new Error("send on destroyed"); } }],
  ]);
  const registry = {
    setCloseListener: (fn) => { listeners.set("close", fn); },
  };
  const webContents = { fromId: (id) => contents.get(id) || null };
  installConnectionClosedPush({ registry, webContents });
  const fire = (entry, reason) => listeners.get("close")(entry, reason);
  return { fire, sent };
}

test("installConnectionClosedPush: idle-timeout close pushes to the owning renderer", () => {
  const { fire, sent } = makeHarness();
  fire({ id: "conn-1", dialect: "postgresql", senderId: 11 }, "idle-timeout");
  assert.deepEqual(sent, [{
    senderId: 11,
    channel: "quolldesk:db:connectionClosed",
    payload: { connectionId: "conn-1", dialect: "postgresql", reason: "idle-timeout" },
  }]);
});

test("installConnectionClosedPush: user/renderer-gone closes do not push", () => {
  const { fire, sent } = makeHarness();
  fire({ id: "conn-1", dialect: "redis", senderId: 11 }, "user");
  fire({ id: "conn-2", dialect: "redis", senderId: 11 }, "renderer-gone");
  assert.deepEqual(sent, []);
});

test("installConnectionClosedPush: destroyed or missing sender is skipped safely", () => {
  const { fire, sent } = makeHarness();
  fire({ id: "conn-3", dialect: "mysql", senderId: 12 }, "driver-error");
  fire({ id: "conn-4", dialect: "mysql", senderId: 999 }, "driver-error");
  fire({ id: "conn-5", dialect: "mysql", senderId: null }, "driver-error");
  assert.deepEqual(sent, []);
});
