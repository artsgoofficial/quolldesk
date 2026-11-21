"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hostBrowserDownloads", Object.freeze({
  list: () => ipcRenderer.invoke("quolldesk:host-browser:downloads:list"),
  theme: () => ipcRenderer.invoke("quolldesk:host-browser:downloads:theme"),
  command: (type, id) => ipcRenderer.invoke("quolldesk:host-browser:downloads:command", { type, id }),
  onChanged: (callback) => {
    const listener = (_event, items) => callback(items);
    ipcRenderer.on("quolldesk:host-browser:downloads-changed", listener);
    return () => ipcRenderer.removeListener("quolldesk:host-browser:downloads-changed", listener);
  },
  onTheme: (callback) => {
    const listener = (_event, theme) => callback(theme);
    ipcRenderer.on("quolldesk:host-browser:theme", listener);
    return () => ipcRenderer.removeListener("quolldesk:host-browser:theme", listener);
  },
}));
