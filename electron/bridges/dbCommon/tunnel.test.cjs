const test = require("node:test");
const assert = require("node:assert/strict");

const released = [];
let dialArgs = null;
const fakeSocket = { destroyed: false, end() { this.destroyed = true; } };

test.beforeEach(() => {
  released.length = 0;
  dialArgs = null;
});

// Inject mocks before loading the module under test.
const tunnel = require("./tunnel.cjs");

test("openDbTunnel dials and wraps socket with release", async () => {
  // The module caches its deps at require time; use the injectable hooks.
  tunnel._setDepsForTests({
    connectThroughChain: async (event, options, jumps, host, port) => {
      dialArgs = { options, jumps, host, port };
      return { socket: fakeSocket, connections: [{ end() { released.push("conn"); } }] };
    },
    borrowTransport: (transport, opts) => released.push(`borrow:${opts.kind}`),
    // Real pool signature: returnTransport(leaseIdOrHolder) — one argument.
    returnTransport: (leaseIdOrHolder) => released.push(`return:${leaseIdOrHolder ?? "x"}`),
  });
  const { socket, release } = await tunnel.openDbTunnel({
    event: { sender: { id: 7 } },
    ssh: { hostname: "jump1", port: 2222, username: "u", password: "p", jumpHosts: [{ hostname: "j0" }] },
    targetHost: "db.internal", targetPort: 3306, connectionId: "c1",
  });
  assert.equal(socket, fakeSocket);
  assert.equal(dialArgs.host, "db.internal");
  assert.equal(dialArgs.port, 3306);
  assert.equal(dialArgs.options.hostname, "jump1");
  assert.equal(dialArgs.options.port, 2222);
  assert.equal(dialArgs.jumps[0].hostname, "j0");
  release();
  assert.ok(released.includes("conn"));
  assert.ok(released.some((r) => String(r).startsWith("return:")));
});

test("openDbTunnel maps dial failure to TUNNEL_FAILED envelope code", async () => {
  tunnel._setDepsForTests({
    connectThroughChain: async () => { throw new Error("all authentication methods failed"); },
    borrowTransport: () => {},
    returnTransport: () => {},
  });
  await assert.rejects(
    () => tunnel.openDbTunnel({ event: { sender: { id: 1 } }, ssh: { hostname: "h" }, targetHost: "t", targetPort: 1, connectionId: "c2" }),
    (err) => err && err.code === "TUNNEL_FAILED",
  );
});
