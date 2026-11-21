const test = require("node:test");
const assert = require("node:assert/strict");
const { registerSqlDialogHandlers, _setDialogForTests } = require("./dialogHandlers.cjs");
const { DB_ERROR_CODES } = require("./resultEnvelope.cjs");

// Fake ipcMain capturing handle() registrations.
function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { handlers.set(channel, fn); },
  };
}

const fakeEvent = { sender: { id: 1 } };

test("registers the two dialog channels under the bridge prefix", () => {
  const ipc = fakeIpcMain();
  registerSqlDialogHandlers(ipc, "quolldesk:mysql");
  assert.ok(ipc.handlers.has("quolldesk:mysql:pickBackupPath"));
  assert.ok(ipc.handlers.has("quolldesk:mysql:pickRestoreFile"));
});

test("pickBackupPath returns the chosen path and passes defaultName plus the SQL filter", async () => {
  const calls = [];
  _setDialogForTests({
    showSaveDialog: async (owner, options) => {
      calls.push({ owner, options });
      return { canceled: false, filePath: "/tmp/dump.sql" };
    },
  });
  const ipc = fakeIpcMain();
  registerSqlDialogHandlers(ipc, "quolldesk:pg");
  const result = await ipc.handlers.get("quolldesk:pg:pickBackupPath")(fakeEvent, { defaultName: "dump.sql" });
  assert.deepEqual(result, { ok: true, data: { path: "/tmp/dump.sql" } });
  assert.equal(calls[0].owner, undefined, "no owner window when dialog module is injected");
  assert.equal(calls[0].options.defaultPath, "dump.sql");
  assert.deepEqual(calls[0].options.filters, [{ name: "SQL", extensions: ["sql"] }]);
});

test("pickBackupPath omits defaultPath when no defaultName and maps cancel to null", async () => {
  _setDialogForTests({
    showSaveDialog: async (_owner, options) => {
      assert.equal(options.defaultPath, undefined);
      return { canceled: true, filePath: undefined };
    },
  });
  const ipc = fakeIpcMain();
  registerSqlDialogHandlers(ipc, "quolldesk:pg");
  const result = await ipc.handlers.get("quolldesk:pg:pickBackupPath")(fakeEvent, {});
  assert.deepEqual(result, { ok: true, data: { path: null } });
});

test("pickRestoreFile returns the first picked file and maps cancel to null", async () => {
  _setDialogForTests({
    showOpenDialog: async (_owner, options) => {
      assert.deepEqual(options.filters, [
        { name: "SQL", extensions: ["sql"] },
        { name: "All", extensions: ["*"] },
      ]);
      assert.deepEqual(options.properties, ["openFile"]);
      return { canceled: false, filePaths: ["/tmp/a.sql", "/tmp/b.sql"] };
    },
  });
  const ipc = fakeIpcMain();
  registerSqlDialogHandlers(ipc, "quolldesk:mysql");
  const picked = await ipc.handlers.get("quolldesk:mysql:pickRestoreFile")(fakeEvent, undefined);
  assert.deepEqual(picked, { ok: true, data: { path: "/tmp/a.sql" } });

  _setDialogForTests({
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  });
  const canceled = await ipc.handlers.get("quolldesk:mysql:pickRestoreFile")(fakeEvent, undefined);
  assert.deepEqual(canceled, { ok: true, data: { path: null } });
});

test("a dialog module missing the expected method yields an INTERNAL envelope", async () => {
  _setDialogForTests({});
  const ipc = fakeIpcMain();
  registerSqlDialogHandlers(ipc, "quolldesk:pg");
  const backup = await ipc.handlers.get("quolldesk:pg:pickBackupPath")(fakeEvent, {});
  const restore = await ipc.handlers.get("quolldesk:pg:pickRestoreFile")(fakeEvent, undefined);
  assert.equal(backup.ok, false);
  assert.equal(backup.error.code, DB_ERROR_CODES.INTERNAL);
  assert.equal(restore.ok, false);
  assert.equal(restore.error.code, DB_ERROR_CODES.INTERNAL);
});

test("dialog errors are classified into the error envelope with the driver message", async () => {
  _setDialogForTests({
    showSaveDialog: async () => {
      throw new Error("certificate verify failed");
    },
  });
  const ipc = fakeIpcMain();
  registerSqlDialogHandlers(ipc, "quolldesk:mysql");
  const result = await ipc.handlers.get("quolldesk:mysql:pickBackupPath")(fakeEvent, {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, DB_ERROR_CODES.TLS_FAILED);
  assert.equal(result.error.message, "certificate verify failed");
});

test("an undefined payload argument is tolerated", async () => {
  _setDialogForTests({
    showSaveDialog: async (_owner, options) => {
      assert.equal(options.defaultPath, undefined);
      return { canceled: false, filePath: "/tmp/x.sql" };
    },
  });
  const ipc = fakeIpcMain();
  registerSqlDialogHandlers(ipc, "quolldesk:pg");
  const result = await ipc.handlers.get("quolldesk:pg:pickBackupPath")(fakeEvent, undefined);
  assert.deepEqual(result, { ok: true, data: { path: "/tmp/x.sql" } });
});
