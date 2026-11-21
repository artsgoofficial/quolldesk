"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hostBrowser", Object.freeze({
  snapshot: () => ipcRenderer.invoke("quolldesk:host-browser:snapshot"),
  command: (command) => ipcRenderer.invoke("quolldesk:host-browser:command", command),
  listBookmarks: () => ipcRenderer.invoke("quolldesk:host-browser:bookmarks:list"),
  saveBookmark: (bookmark) => ipcRenderer.invoke("quolldesk:host-browser:bookmarks:upsert", bookmark),
  removeBookmark: (id) => ipcRenderer.invoke("quolldesk:host-browser:bookmarks:remove", id),
  listDownloads: () => ipcRenderer.invoke("quolldesk:host-browser:downloads:list"),
  onDownloadsChanged: (callback) => {
    const listener = (_event, downloads) => callback(downloads);
    ipcRenderer.on("quolldesk:host-browser:downloads-changed", listener);
    return () => ipcRenderer.removeListener("quolldesk:host-browser:downloads-changed", listener);
  },
  onBookmarksChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("quolldesk:host-browser:bookmarks-changed", listener);
    return () => ipcRenderer.removeListener("quolldesk:host-browser:bookmarks-changed", listener);
  },
  onSiteIconsChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("quolldesk:host-browser:site-icons-changed", listener);
    return () => ipcRenderer.removeListener("quolldesk:host-browser:site-icons-changed", listener);
  },
  onShortcut: (callback) => {
    const listener = (_event, shortcut) => callback(shortcut);
    ipcRenderer.on("quolldesk:host-browser:shortcut", listener);
    return () => ipcRenderer.removeListener("quolldesk:host-browser:shortcut", listener);
  },
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("quolldesk:host-browser:state", listener);
    return () => ipcRenderer.removeListener("quolldesk:host-browser:state", listener);
  },
}));
