const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// mysql2/pg/node-pty/serialport load lazily inside their bridges: requiring the
// bridge module at app boot must not pay for driver parsing, and a broken
// native build must only break its own feature, not the whole app. These tests
// fail if someone re-adds an eager top-level require.

const HEAVY_MODULES = new Set(["node-pty", "serialport", "mysql2", "pg", "pg-query-stream"]);

function requireBridgeTrackingHeavyModules(bridgePath) {
  const loaded = new Set();
  const originalLoad = Module._load;
  Module._load = function trackedLoad(request, parent, isMain) {
    if (HEAVY_MODULES.has(request)) loaded.add(request);
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(bridgePath)];
    require(bridgePath);
  } finally {
    Module._load = originalLoad;
  }
  return loaded;
}

test("terminalBridge require does not load node-pty or serialport", () => {
  const loaded = requireBridgeTrackingHeavyModules("./terminalBridge.cjs");
  assert.deepEqual([...loaded].filter((name) => name === "node-pty" || name === "serialport"), []);
});

test("mysqlBridge require does not load mysql2", () => {
  const loaded = requireBridgeTrackingHeavyModules("./mysqlBridge.cjs");
  assert.deepEqual([...loaded].filter((name) => name === "mysql2"), []);
});

test("pgBridge require does not load pg or pg-query-stream", () => {
  const loaded = requireBridgeTrackingHeavyModules("./pgBridge.cjs");
  assert.deepEqual([...loaded].filter((name) => name === "pg" || name === "pg-query-stream"), []);
});
