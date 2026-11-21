"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const listen = (channel, callback) => { const handler = (_event, value) => callback(value); ipcRenderer.on(channel, handler); return () => ipcRenderer.removeListener(channel, handler); };
contextBridge.exposeInMainWorld("quolldesk", {
  getPluginRuntimeStatus: () => ipcRenderer.invoke("quolldesk:plugins:status"),
  getPluginContributions: (query) => ipcRenderer.invoke("quolldesk:plugins:contributions", query),
  updatePluginSetting: (pluginId, settingId, value, scopeId) => ipcRenderer.invoke("quolldesk:plugins:update-setting", { pluginId, settingId, value, scopeId }),
  resetPluginSetting: (pluginId, settingId, scopeId) => ipcRenderer.invoke("quolldesk:plugins:reset-setting", { pluginId, settingId, scopeId }),
  onPluginContributionsChanged: (callback) => listen("quolldesk:plugins:contributions-changed", callback),
  getPluginViewResource: (payload) => ipcRenderer.invoke("quolldesk:plugins:host-ui-resource", payload),
  openHostDrawnPluginView: (payload) => ipcRenderer.invoke("quolldesk:plugins:host-ui-open", payload),
  closeHostDrawnPluginView: (instanceId) => ipcRenderer.invoke("quolldesk:plugins:host-ui-close", { instanceId }),
  sendHostDrawnPluginViewEvent: (instanceId, event) => ipcRenderer.invoke("quolldesk:plugins:host-ui-event", { instanceId, event }),
  onHostDrawnPluginViewUpdate: (callback) => listen("quolldesk:plugins:host-ui-update", callback),
  onPluginViewClosed: (callback) => listen("quolldesk:plugins:view-closed", callback),
});
