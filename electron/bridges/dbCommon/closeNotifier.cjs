"use strict";

// Renderer sync for database connections closed by the main process. The
// connection registry evicts entries the renderer still holds a connectionId
// for (10-min idle reap, driver death), and without a push the workbench tab
// keeps showing a green "connected" dot while every query fails with
// NOT_CONNECTED — the "状态显示不准" bug. This module installs the registry
// close listener that pushes quolldesk:db:connectionClosed to the owning
// renderer so useDatabaseWorkbenchState can flip to 'disconnected'.

// Reasons the renderer already knows about and handles itself: a manual
// disconnect flips the workbench state in the same call, a renderer-gone
// sweep has no live renderer to tell, and test resets own their assertions.
// Everything else (idle reap, driver death, future reasons) is invisible to
// the renderer and must be pushed.
const RENDERER_KNOWN_REASONS = new Set(["user", "renderer-gone", "test-reset"]);

function shouldNotifyRenderer(reason) {
  return !RENDERER_KNOWN_REASONS.has(String(reason));
}

/**
 * Install the shared registry close listener. One listener for all three DB
 * bridges (the registry is a process-wide singleton), so call this once at
 * bridge registration — not per bridge.
 */
function installConnectionClosedPush({ registry, webContents, channel = "quolldesk:db:connectionClosed" }) {
  registry.setCloseListener((entry, reason) => {
    if (!shouldNotifyRenderer(reason)) return;
    const sender = entry?.senderId != null ? webContents.fromId(entry.senderId) : null;
    if (!sender || sender.isDestroyed()) return;
    sender.send(channel, { connectionId: entry.id, dialect: entry.dialect, reason });
  });
}

/**
 * Evict a just-registered connection when its driver emits a fatal event.
 * None of the three drivers reconnects (pg/mysql2 are done after a fatal
 * error; node-redis is dialed with reconnectStrategy:false), so error/end
 * mean the connection is dead — evict so the renderer gets a close push and
 * ops fail with NOT_CONNECTED instead of dying inside a broken driver.
 * `on` is optional-called: test fakes may not be EventEmitters, and
 * closeConnection is a no-op once the entry is gone, so double-fire is safe.
 */
function watchDriverDeath(emitter, connectionId, registry) {
  for (const event of ["error", "end"]) {
    emitter.on?.(event, () => registry.closeConnection(connectionId, "driver-error"));
  }
}

module.exports = { installConnectionClosedPush, watchDriverDeath, shouldNotifyRenderer, RENDERER_KNOWN_REASONS };
