"use strict";

const {
  connectThroughChain,
} = require("../sshBridge.cjs");
const {
  createTransport, borrowTransport, returnTransport, LEASE_KINDS,
} = require("../sshConnectionPool.cjs");
const { DB_ERROR_CODES } = require("./resultEnvelope.cjs");

let deps = { connectThroughChain, createTransport, borrowTransport, returnTransport, LEASE_KINDS };

/** Test hook: replace ssh/pool dependencies. */
function _setDepsForTests(next) { deps = { ...deps, ...next }; }

function serializeHop(hop) {
  return {
    hostname: hop.hostname,
    port: hop.port ?? 22,
    username: hop.username,
    password: hop.password,
    privateKeyPath: hop.privateKeyPath,
    passphrase: hop.passphrase,
    // Auth helpers read these optional fields; keep undefined when absent.
  };
}

/**
 * Open a duplex socket to targetHost:targetPort through an SSH host (plus its
 * jump chain). Borrows a `forward` lease on the shared transport registry so
 * terminal/SFTP can reuse the same authenticated connection later.
 *
 * Pool signatures (see sshConnectionPool.cjs / portForwardingBridge.cjs):
 * - borrowTransport(transport, { kind, holder, leaseId, meta }) → { leaseId }
 * - returnTransport(leaseIdOrHolder) — one argument, lease id or holder.
 */
async function openDbTunnel({ event, ssh, targetHost, targetPort, connectionId }) {
  if (!ssh || !ssh.hostname || !targetHost) {
    const err = new Error("tunnel requires ssh.hostname and targetHost");
    // @ts-expect-error code
    err.code = DB_ERROR_CODES.INVALID_PARAMS;
    throw err;
  }
  const jumps = Array.isArray(ssh.jumpHosts) ? ssh.jumpHosts.map(serializeHop) : [];
  const options = {
    ...serializeHop(ssh),
    keepaliveInterval: 30_000,
    keepaliveCountMax: 3,
  };
  let result;
  try {
    result = await deps.connectThroughChain(
      event, options, jumps, targetHost, targetPort,
      `db:${connectionId}`, () => {},
    );
  } catch (err) {
    const wrapped = new Error(`SSH tunnel failed: ${err?.message || err}`);
    // @ts-expect-error code
    wrapped.code = DB_ERROR_CODES.TUNNEL_FAILED;
    wrapped.cause = err;
    throw wrapped;
  }

  const connections = Array.isArray(result.connections) ? result.connections : [];
  const endpoint = `db-tunnel:${targetHost}:${targetPort}`;
  let transport = null;
  let leaseId = null;
  const holder = { kind: "db-tunnel", connectionId };
  const lastConn = connections[connections.length - 1];
  if (lastConn) {
    try {
      transport = deps.createTransport({
        conn: lastConn,
        chainConnections: connections.slice(0, -1),
        endpoint,
      });
      const borrowed = deps.borrowTransport(transport, {
        kind: deps.LEASE_KINDS.forward,
        holder,
        leaseId: `db-tunnel:${connectionId}`,
        meta: { source: "db-client" },
      });
      leaseId = borrowed?.leaseId || `db-tunnel:${connectionId}`;
    } catch (err) {
      // Lease attach failed: no one can reuse this transport, so end the
      // whole dialed chain instead of leaking it (pool close handlers clean
      // up any already-registered transport).
      for (const conn of connections) {
        try { conn.end(); } catch { /* ignore */ }
      }
      throw err;
    }
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (transport) deps.returnTransport(leaseId || holder);
    } catch { /* pool may not know this transport; fall through to raw end */ }
    for (const conn of connections) {
      try { conn.end(); } catch { /* ignore */ }
    }
  };

  return { socket: result.socket, release };
}

module.exports = { openDbTunnel, _setDepsForTests };
