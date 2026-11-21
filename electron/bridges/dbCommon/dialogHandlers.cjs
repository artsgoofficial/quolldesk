"use strict";

const {
  okEnvelope, errorEnvelope, DB_ERROR_CODES, classifyDriverError,
} = require("./resultEnvelope.cjs");

// Native dialog module is injectable so unit tests never touch electron.
let dialogModule = null;
function _setDialogForTests(next) { dialogModule = next ?? null; }
function electronDialog() {
  if (dialogModule) return { dialog: dialogModule, BrowserWindow: null };
  // Lazy require: in the packaged app this is the real electron module.
  const electron = require("electron");
  return { dialog: electron.dialog, BrowserWindow: electron.BrowserWindow };
}

/**
 * Register the shared backup/restore file-dialog handlers for one SQL
 * dialect bridge: `<prefix>:pickBackupPath` (save dialog, .sql filter) and
 * `<prefix>:pickRestoreFile` (open dialog). Both SQL bridges pass their
 * `quolldesk:mysql` / `quolldesk:pg` prefix.
 */
function registerSqlDialogHandlers(ipcMain, prefix) {
  ipcMain.handle(`${prefix}:pickBackupPath`, async (event, { defaultName } = {}) => {
    try {
      const { dialog, BrowserWindow } = electronDialog();
      if (!dialog?.showSaveDialog) return errorEnvelope(DB_ERROR_CODES.INTERNAL, "dialog unavailable");
      const owner = BrowserWindow?.fromWebContents?.(event.sender) || undefined;
      const result = await dialog.showSaveDialog(owner, {
        defaultPath: defaultName || undefined,
        filters: [{ name: "SQL", extensions: ["sql"] }],
      });
      const path = !result?.canceled && result?.filePath ? result.filePath : null;
      return okEnvelope({ path });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "pickBackupPath failed");
    }
  });

  ipcMain.handle(`${prefix}:pickRestoreFile`, async (event) => {
    try {
      const { dialog, BrowserWindow } = electronDialog();
      if (!dialog?.showOpenDialog) return errorEnvelope(DB_ERROR_CODES.INTERNAL, "dialog unavailable");
      const owner = BrowserWindow?.fromWebContents?.(event.sender) || undefined;
      const result = await dialog.showOpenDialog(owner, {
        filters: [{ name: "SQL", extensions: ["sql"] }, { name: "All", extensions: ["*"] }],
        properties: ["openFile"],
      });
      const path = !result?.canceled && Array.isArray(result?.filePaths) && result.filePaths[0] ? result.filePaths[0] : null;
      return okEnvelope({ path });
    } catch (err) {
      return errorEnvelope(classifyDriverError(err), err?.message || "pickRestoreFile failed");
    }
  });
}

module.exports = { registerSqlDialogHandlers, _setDialogForTests };
