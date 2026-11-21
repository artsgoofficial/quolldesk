"use strict";

const { randomUUID } = require("node:crypto");

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
let idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;

/** @type {Map<string, { id: string, dialect: string, senderId: number, client: unknown, tunnel: unknown, meta: Record<string, unknown> | null, close: (reason: string) => void, timer: NodeJS.Timeout | null }> } */
const connectionsById = new Map();

// Fired on every closeConnection so the main process can push the loss to the
// renderer that still holds the connection (see dbCommon/closeNotifier.cjs).
let closeListener = null;

function armIdleTimer(entry) {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    closeConnection(entry.id, "idle-timeout");
  }, idleTimeoutMs);
  if (typeof entry.timer.unref === "function") entry.timer.unref();
}

function registerConnection({ dialect, senderId, client, tunnel, close, meta }) {
  const id = randomUUID();
  const entry = {
    id, dialect, senderId, client, tunnel,
    meta: meta || null,
    close: typeof close === "function" ? close : () => {},
    timer: null,
  };
  connectionsById.set(id, entry);
  armIdleTimer(entry);
  return id;
}

function getConnection(id) { return connectionsById.get(id); }

function listConnections() {
  return Array.from(connectionsById.values()).map((entry) => ({
    id: entry.id,
    dialect: entry.dialect,
    meta: entry.meta,
  }));
}

function touchConnection(id) {
  const entry = connectionsById.get(id);
  if (!entry) return false;
  armIdleTimer(entry);
  return true;
}

function closeConnection(id, reason = "closed") {
  const entry = connectionsById.get(id);
  if (!entry) return false;
  connectionsById.delete(id);
  if (entry.timer) clearTimeout(entry.timer);
  try { entry.close(reason); } catch (err) { console.warn("[dbCommon] close failed:", err?.message); }
  if (closeListener) {
    try { closeListener(entry, reason); } catch (err) { console.warn("[dbCommon] close listener failed:", err?.message); }
  }
  return true;
}

function setCloseListener(fn) {
  closeListener = typeof fn === "function" ? fn : null;
}

function closeAllForSender(senderId) {
  let count = 0;
  for (const [id, entry] of connectionsById) {
    if (entry.senderId === senderId) {
      closeConnection(id, "renderer-gone");
      count += 1;
    }
  }
  return count;
}

function setIdleTimeoutMs(ms) {
  idleTimeoutMs = Math.max(1, Number(ms) || DEFAULT_IDLE_TIMEOUT_MS);
  for (const entry of connectionsById.values()) armIdleTimer(entry);
}
function size() { return connectionsById.size; }
function _resetForTests() {
  for (const [id] of connectionsById) closeConnection(id, "test-reset");
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
}

module.exports = {
  registerConnection, getConnection, listConnections, touchConnection,
  closeConnection, closeAllForSender, setIdleTimeoutMs, setCloseListener, size, _resetForTests,
};
