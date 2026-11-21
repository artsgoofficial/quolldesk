"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const sftpBridge = require("./sftpBridge.cjs");

test("renderer SFTP operations keep their source terminal session active", async () => {
  const handlers = new Map();
  const activity = [];
  const requests = [];
  const ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  };
  const terminalWorkerManager = {
    async request(channel, payload) {
      requests.push({ channel, payload });
      if (channel === "quolldesk:sftp:openForSession") {
        return { sftpId: "sftp-1", sourceSessionId: "terminal-2" };
      }
      if (channel === "quolldesk:sftp:list") return [];
      if (channel === "quolldesk:sftp:close") return { ok: true };
      throw new Error(`Unexpected channel: ${channel}`);
    },
  };
  sftpBridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: {},
    reportOpenedSessionActivity: (event) => activity.push(event),
  });
  sftpBridge.registerHandlers(ipcMain, { terminalWorkerManager });
  const event = { sender: { id: 7 } };

  await handlers.get("quolldesk:sftp:openForSession")(event, { sessionId: "terminal-1" });
  await handlers.get("quolldesk:sftp:list")(event, { sftpId: "sftp-1", path: "/tmp" });
  await handlers.get("quolldesk:sftp:close")(event, { sftpId: "sftp-1" });

  assert.deepEqual(requests.map((entry) => entry.channel), [
    "quolldesk:sftp:openForSession",
    "quolldesk:sftp:list",
    "quolldesk:sftp:close",
  ]);
  assert.deepEqual(activity, [
    { sessionId: "terminal-1", phase: "begin" },
    { sessionId: "terminal-2", phase: "touch" },
    { sessionId: "terminal-1", phase: "end" },
    { sessionId: "terminal-2", phase: "begin" },
    { sessionId: "terminal-2", phase: "end" },
    { sessionId: "terminal-2", phase: "begin" },
    { sessionId: "terminal-2", phase: "end" },
  ]);
});
