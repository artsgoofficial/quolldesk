const {
  clearTerminalDataSession,
  hasPluginPipelineIngressMarker,
} = require("./terminalDataBacklog.cjs");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const { stageRendererFileToTemp } = require("./stageUploadFile.cjs");

function createPreloadApi(ctx) {
  const sessionLogFinalizers = new Set();
  let pendingSessionLogFinalization = null;
  ctx.ipcRenderer?.on?.("app:finalize-session-logs", async (_event, { requestId }) => {
    const pending = pendingSessionLogFinalization ??= Promise.allSettled(
      [...sessionLogFinalizers].map((finalize) => Promise.resolve().then(finalize)),
    );
    const results = await pending;
    if (pendingSessionLogFinalization === pending) pendingSessionLogFinalization = null;
    ctx.ipcRenderer.send("app:session-logs-finalized", {
      requestId,
      success: results.every((result) => result.status === "fulfilled"),
    });
  });
  const terminalDataBacklog = ctx.terminalDataBacklog || null;
  const displayDataListeners = ctx.displayDataListeners || new Map();
  const closedTerminalDataSessions = ctx.closedTerminalDataSessions || null;
  const globalSftpTransferListeners = ctx.globalSftpTransferListeners || new Set();
  const pluginContributionsChangedListeners = ctx.pluginContributionsChangedListeners || new Set();
  const uploadStageControllers = new Map();
  const hostBrowserPanelListeners = new Set();
  const pendingHostBrowserPanels = [];
  // TerminalLayer mounts lazily; retain incoming requests until it subscribes.
  ctx.ipcRenderer?.on?.("quolldesk:host-browser:request-panel", (_event, request) => {
    if (!hostBrowserPanelListeners.size) {
      pendingHostBrowserPanels.push(request);
      return;
    }
    for (const listener of hostBrowserPanelListeners) listener(request);
  });
  // Lightweight test contexts may omit this map; default so closeSession never throws.
  if (!ctx.moshSessionReadyListeners) {
    ctx.moshSessionReadyListeners = new Map();
  }
  const markTerminalDataSessionOpen = (sessionId) => {
    if (!sessionId) return;
    closedTerminalDataSessions?.delete?.(sessionId);
  };
  const markRequestedTerminalDataSessionOpen = (options) => {
    markTerminalDataSessionOpen(options?.sessionId);
  };
  const markTerminalDataSessionClosed = (sessionId) => {
    if (!sessionId) return;
    closedTerminalDataSessions?.add?.(sessionId);
    ctx.clearTerminalOutputSessionState?.(sessionId);
    clearTerminalDataSession({
      dataListeners: ctx.dataListeners,
      displayDataListeners,
      terminalDataBacklog,
    }, sessionId);
    ctx.terminalOutputPorts?.closeSession?.(sessionId);
  };
  const removeSessionListener = (listeners, sessionId, cb) => {
    const set = listeners?.get?.(sessionId);
    set?.delete(cb);
    if (set?.size === 0) listeners.delete(sessionId);
  };
  const clearSessionScopedTerminalListeners = (sessionId) => {
    ctx.telnetAutoLoginCompleteListeners?.delete?.(sessionId);
    ctx.telnetAutoLoginCancelledListeners?.delete?.(sessionId);
    ctx.moshSessionReadyListeners?.delete?.(sessionId);
    ctx.telnetEchoModeListeners?.delete?.(sessionId);
    ctx.authFailedListeners?.delete?.(sessionId);
  };
  const sanitizeInterruptTrace = (trace) => {
    if (!trace || typeof trace !== "object") return undefined;
    const priority = trace.rendererPriority && typeof trace.rendererPriority === "object"
      ? {
          sessionId: typeof trace.rendererPriority.sessionId === "string" ? trace.rendererPriority.sessionId : null,
          backlogBytes: Number(trace.rendererPriority.backlogBytes) || 0,
          writeQueueDepth: Number(trace.rendererPriority.writeQueueDepth) || 0,
          deferredAckBytes: Number(trace.rendererPriority.deferredAckBytes) || 0,
          ackAfterInputBytes: Number(trace.rendererPriority.ackAfterInputBytes) || 0,
          scheduledBackendResume: Boolean(trace.rendererPriority.scheduledBackendResume),
          skippedReason: typeof trace.rendererPriority.skippedReason === "string" ? trace.rendererPriority.skippedReason : undefined,
        }
      : undefined;
    return {
      debug: trace.debug === true,
      traceId: typeof trace.traceId === "string" ? trace.traceId.slice(0, 128) : undefined,
      source: typeof trace.source === "string" ? trace.source.slice(0, 80) : undefined,
      sessionId: typeof trace.sessionId === "string" ? trace.sessionId : undefined,
      rendererKeyAt: Number.isFinite(trace.rendererKeyAt) ? trace.rendererKeyAt : undefined,
      rendererSendAt: Number.isFinite(trace.rendererSendAt) ? trace.rendererSendAt : undefined,
      rendererStatus: typeof trace.rendererStatus === "string" ? trace.rendererStatus.slice(0, 40) : undefined,
      rendererHasSelection: trace.rendererHasSelection === true,
      rendererPriority: priority,
    };
  };
  const sanitizeKittyKeyboardModeState = (value) => {
    if (!value || typeof value !== "object") return undefined;
    const flags = (input) => Number.isFinite(input) ? Math.max(0, Math.floor(input)) & 31 : 0;
    const stack = (input) => Array.isArray(input)
      ? input.slice(-32).map(flags)
      : [];
    return {
      mainFlags: flags(value.mainFlags),
      alternateFlags: flags(value.alternateFlags),
      mainStack: stack(value.mainStack),
      alternateStack: stack(value.alternateStack),
      alternateScreenActive: value.alternateScreenActive === true,
    };
  };
  with (ctx) {
    return {
  getPluginRuntimeStatus: () => ipcRenderer.invoke("quolldesk:plugins:status"),
  getPluginSourceBinding: (pluginId) => ipcRenderer.invoke("quolldesk:plugins:source-binding", { pluginId }),
  resetPluginSource: (pluginId, expectedSourceId) => ipcRenderer.invoke("quolldesk:plugins:reset-source", { pluginId, expectedSourceId }),
  listPluginSources: () => ipcRenderer.invoke("quolldesk:plugins:sources"),
  addPluginSource: (source) => ipcRenderer.invoke("quolldesk:plugins:add-source", source),
  updatePluginSource: (source) => ipcRenderer.invoke("quolldesk:plugins:update-source", source),
  removePluginSource: (id, disablePlugins) => ipcRenderer.invoke("quolldesk:plugins:remove-source", { id, disablePlugins }),
  listPluginCatalog: (sourceId) => ipcRenderer.invoke("quolldesk:plugins:catalog", { sourceId }),
  getPluginAuthorPresentation: (request) => ipcRenderer.invoke("quolldesk:plugins:author", request),
  onPluginCatalogChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("quolldesk:plugins:catalog-changed", listener);
    return () => ipcRenderer.removeListener("quolldesk:plugins:catalog-changed", listener);
  },
  getPluginCatalogReadme: (id, selectionToken, sourceId) => ipcRenderer.invoke("quolldesk:plugins:catalog-readme", { id, selectionToken, sourceId }),
  getPluginCatalogReadmeImages: (id, selectionToken, sourceId) => ipcRenderer.invoke("quolldesk:plugins:catalog-readme-images", { id, selectionToken, sourceId }),
  installCatalogPlugin: (id, selectionToken, sourceId, acceptedSourceId) => ipcRenderer.invoke("quolldesk:plugins:catalog-install", { id, selectionToken, sourceId, acceptedSourceId }),
  setPluginAIHostReady: (ready) => ipcRenderer.invoke("quolldesk:plugins:ai-host-ready", ready),
  setPluginAgentHostReady: (ready) => ipcRenderer.invoke("quolldesk:plugins:agent-host-ready", ready),
  respondPluginAgentHost: (response) => ipcRenderer.invoke("quolldesk:plugins:agent-host-response", response),
  onPluginAgentHostRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("quolldesk:plugins:agent-host-request", listener);
    return () => ipcRenderer.removeListener("quolldesk:plugins:agent-host-request", listener);
  },
  respondPluginAIHost: (response) => ipcRenderer.invoke("quolldesk:plugins:ai-host-response", response),
  onPluginAIHostRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("quolldesk:plugins:ai-host-request", listener);
    return () => ipcRenderer.removeListener("quolldesk:plugins:ai-host-request", listener);
  },
  setPluginInteractionReady: (ready) => ipcRenderer.invoke("quolldesk:plugins:interaction-ready", { ready }),
  respondPluginInteraction: (response) => ipcRenderer.invoke("quolldesk:plugins:interaction-response", response),
  onPluginInteraction: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("quolldesk:plugins:host-interaction", listener);
    return () => ipcRenderer.removeListener("quolldesk:plugins:host-interaction", listener);
  },
  listPlugins: () => ipcRenderer.invoke("quolldesk:plugins:list"),
  setPluginPermissionMode: (pluginId, permission, mode, policyRevision) => ipcRenderer.invoke("quolldesk:plugins:set-permission-mode", { pluginId, permission, mode, policyRevision }),
  setPluginPermissionReady: (ready) => ipcRenderer.invoke("quolldesk:plugins:permission-ready", { ready }),
  respondPluginPermission: (response) => ipcRenderer.invoke("quolldesk:plugins:permission-response", response),
  onPluginPermission: (callback) => {
    const listener = (_event, prompt) => callback(prompt);
    ipcRenderer.on("quolldesk:plugins:permission-prompt", listener);
    return () => ipcRenderer.removeListener("quolldesk:plugins:permission-prompt", listener);
  },
  getPluginPermissions: (pluginId) => ipcRenderer.invoke("quolldesk:plugins:permissions", { pluginId }),
  revokePluginPermissions: (pluginId) => ipcRenderer.invoke("quolldesk:plugins:revoke-permissions", { pluginId }),
  prepareGitHubPlugin: (repository) => ipcRenderer.invoke("quolldesk:plugins:github-prepare", { repository }),
  installGitHubPlugin: (token) => ipcRenderer.invoke("quolldesk:plugins:github-install", { token }),
  discardGitHubPlugin: (token) => ipcRenderer.invoke("quolldesk:plugins:github-discard", { token }),
  installPluginPackage: (archivePath, options) => ipcRenderer.invoke("quolldesk:plugins:install", {
    archivePath,
    enable: options?.enable === true,
  }),
  setPluginEnabled: (pluginId, enabled) => ipcRenderer.invoke("quolldesk:plugins:set-enabled", {
    pluginId,
    enabled: enabled === true,
  }),
  restartPlugin: (pluginId) => ipcRenderer.invoke("quolldesk:plugins:restart", { pluginId }),
  uninstallPlugin: (pluginId) => ipcRenderer.invoke("quolldesk:plugins:uninstall", { pluginId }),
  getPluginLogStatus: () => ipcRenderer.invoke("quolldesk:plugins:log-status"),
  configurePluginLogs: (settings) => ipcRenderer.invoke("quolldesk:plugins:log-configure", settings),
  openPluginLogFolder: () => ipcRenderer.invoke("quolldesk:plugins:log-open"),
  exportPluginLogs: () => ipcRenderer.invoke("quolldesk:plugins:log-export"),
  clearPluginLogs: () => ipcRenderer.invoke("quolldesk:plugins:log-clear"),
  setPluginTerminalTarget: (target) => ipcRenderer.invoke("quolldesk:plugins:terminal-target", target),
  getPluginThemes: () => ipcRenderer.invoke("quolldesk:plugins:theme-catalog"),
  applyPluginTheme: (request) => ipcRenderer.invoke("quolldesk:plugins:theme-apply", request),
  onPluginThemesChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("quolldesk:plugins:themes-changed", listener);
    return () => ipcRenderer.removeListener("quolldesk:plugins:themes-changed", listener);
  },
  onSystemThemeChanged: (callback) => {
    const listener = (_event, payload) => {
      if (typeof payload?.isDark === "boolean") callback({ isDark: payload.isDark });
    };
    ipcRenderer.on("quolldesk:system-theme-changed", listener);
    return () => ipcRenderer.removeListener("quolldesk:system-theme-changed", listener);
  },
  getPluginContributions: (options) => ipcRenderer.invoke("quolldesk:plugins:contributions", options ?? {}),
  getPluginBrandIcon: (pluginId) => ipcRenderer.invoke("quolldesk:plugins:brand-icon", { pluginId }),
  getPluginContributionIcon: (pluginId, icon) => ipcRenderer.invoke("quolldesk:plugins:contribution-icon", { pluginId, icon }),
  executePluginCommand: (command, args, context) => ipcRenderer.invoke("quolldesk:plugins:execute-command", {
    command,
    ...(args === undefined ? {} : { args }),
    ...(context === undefined ? {} : { context }),
  }),
  updatePluginSetting: (pluginId, settingId, value, scopeId) => ipcRenderer.invoke(
    "quolldesk:plugins:update-setting",
    { pluginId, settingId, value, ...(scopeId === undefined ? {} : { scopeId }) },
  ),
  resetPluginSetting: (pluginId, settingId, scopeId) => ipcRenderer.invoke(
    "quolldesk:plugins:reset-setting",
    { pluginId, settingId, ...(scopeId === undefined ? {} : { scopeId }) },
  ),
  setPluginEnvironment: (environment) => ipcRenderer.invoke("quolldesk:plugins:set-environment", environment),
  listPluginTerminalProviders: (options) => ipcRenderer.invoke("quolldesk:plugins:terminal-providers", options ?? {}),
  providePluginTerminal: (request) => ipcRenderer.invoke("quolldesk:plugins:terminal-provide", request),
  cancelPluginTerminalRequest: (requestId) => ipcRenderer.invoke("quolldesk:plugins:terminal-cancel", { requestId }),
  publishPluginTerminalSessionEvent: (event) => ipcRenderer.invoke("quolldesk:plugins:terminal-session-event", event),
  listPluginExtensionProviders: (options) => ipcRenderer.invoke("quolldesk:plugins:extension-providers", options ?? {}),
  updatePluginCredentialCatalog: (entries) => ipcRenderer.invoke(
    "quolldesk:plugins:credential-catalog-update",
    { entries },
  ),
  invokePluginExtensionProvider: (request) => ipcRenderer.invoke("quolldesk:plugins:extension-invoke", {
    requestId: request?.requestId ?? randomUUID(),
    ...request,
  }),
  cancelPluginExtensionRequest: (requestId) => ipcRenderer.invoke("quolldesk:plugins:extension-cancel", { requestId }),
  pluginSyncConnect: (request) => {
    const requestId = typeof request?.requestId === "string" && request.requestId
      ? request.requestId
      : randomUUID();
    return ipcRenderer.invoke("quolldesk:plugins:sync-connect", { ...request, requestId });
  },
  pluginSyncDisconnect: (request) => {
    const requestId = typeof request?.requestId === "string" && request.requestId
      ? request.requestId
      : randomUUID();
    return ipcRenderer.invoke("quolldesk:plugins:sync-disconnect", { ...request, requestId });
  },
  pluginSyncGetAccount: (request) => {
    const requestId = typeof request?.requestId === "string" && request.requestId
      ? request.requestId
      : randomUUID();
    return ipcRenderer.invoke("quolldesk:plugins:sync-get-account", { ...request, requestId });
  },
  pluginSyncGetCapabilities: (request) => {
    const requestId = typeof request?.requestId === "string" && request.requestId
      ? request.requestId
      : randomUUID();
    return ipcRenderer.invoke("quolldesk:plugins:sync-get-capabilities", { ...request, requestId });
  },
  pluginSyncReadObject: (request) => {
    const requestId = typeof request?.requestId === "string" && request.requestId
      ? request.requestId
      : randomUUID();
    return ipcRenderer.invoke("quolldesk:plugins:sync-read-object", { ...request, requestId });
  },
  pluginSyncReadChunk: (request) => ipcRenderer.invoke("quolldesk:plugins:sync-read-chunk", request),
  pluginSyncWriteObject: (request) => {
    const requestId = typeof request?.requestId === "string" && request.requestId
      ? request.requestId
      : randomUUID();
    return ipcRenderer.invoke("quolldesk:plugins:sync-write-object", { ...request, requestId });
  },
  pluginSyncWriteBegin: (request) => {
    const requestId = typeof request?.requestId === "string" && request.requestId
      ? request.requestId
      : randomUUID();
    return ipcRenderer.invoke("quolldesk:plugins:sync-write-begin", { ...request, requestId });
  },
  pluginSyncWriteChunk: (request) => ipcRenderer.invoke("quolldesk:plugins:sync-write-chunk", request),
  pluginSyncWriteCommit: (request) => ipcRenderer.invoke("quolldesk:plugins:sync-write-commit", request),
  pluginSyncDeleteObject: (request) => {
    const requestId = typeof request?.requestId === "string" && request.requestId
      ? request.requestId
      : randomUUID();
    return ipcRenderer.invoke("quolldesk:plugins:sync-delete-object", { ...request, requestId });
  },
  pluginSyncPutSecret: (request) => ipcRenderer.invoke("quolldesk:plugins:sync-put-secret", request ?? {}),
  pluginSyncDeleteSecrets: (request) => ipcRenderer.invoke("quolldesk:plugins:sync-delete-secrets", request ?? {}),
  pluginSyncRestoreSecrets: (request) => ipcRenderer.invoke("quolldesk:plugins:sync-restore-secrets", request ?? {}),
  collectPluginSyncSidecars: () => ipcRenderer.invoke("quolldesk:plugins:sync-sidecars-collect", {}),
  applyPluginSyncSidecars: (bundle) => ipcRenderer.invoke("quolldesk:plugins:sync-sidecars-apply", bundle ?? { version: 1, entries: [] }),
  /** True only when the main-process plugin host wired a sidecar service. */
  pluginHostReady: () => {
    try {
      return ipcRenderer.sendSync("quolldesk:plugins:host-available-sync") === true;
    } catch {
      return false;
    }
  },
  startPluginConnection: async (request) => {
    markRequestedTerminalDataSessionOpen(request);
    const result = await ipcRenderer.invoke("quolldesk:plugins:connection-start", {
      requestId: request?.requestId ?? randomUUID(),
      ...request,
    });
    markTerminalDataSessionOpen(result?.sessionId);
    return result;
  },
  writePluginConnection: (sessionId, data) => ipcRenderer.invoke("quolldesk:plugins:connection-write", { sessionId, data }),
  controlPluginConnection: (sessionId, operation, payload) => ipcRenderer.invoke(
    "quolldesk:plugins:connection-control",
    { sessionId, operation, payload: payload ?? {} },
  ),
  detectPluginImporter: (request) => ipcRenderer.invoke("quolldesk:plugins:importer-detect", {
    requestId: request?.requestId ?? randomUUID(),
    ...request,
  }),
  selectPluginImporterFile: () => ipcRenderer.invoke("quolldesk:plugins:importer-select-file", {}),
  releasePluginImporterFile: (selectionToken) => ipcRenderer.invoke(
    "quolldesk:plugins:importer-release-file",
    { selectionToken },
  ),
  parsePluginImporterFile: (request) => ipcRenderer.invoke("quolldesk:plugins:importer-parse-file", {
    requestId: request?.requestId ?? randomUUID(),
    ...request,
  }),
  onPluginImporterProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("quolldesk:plugins:importer-progress", listener);
    return () => ipcRenderer.removeListener("quolldesk:plugins:importer-progress", listener);
  },
  respondPluginAuthenticationChallenge: (response) => ipcRenderer.invoke(
    "quolldesk:plugins:authentication-respond",
    response,
  ),
  onPluginAuthenticationChallenge: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("quolldesk:plugins:authentication-challenge", listener);
    return () => ipcRenderer.removeListener("quolldesk:plugins:authentication-challenge", listener);
  },
  onPluginConnectionData: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("quolldesk:plugins:connection-data", listener);
    return () => ipcRenderer.removeListener("quolldesk:plugins:connection-data", listener);
  },
  onPluginConnectionClosed: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("quolldesk:plugins:connection-closed", listener);
    return () => ipcRenderer.removeListener("quolldesk:plugins:connection-closed", listener);
  },
  getPluginViewResource: (payload) => ipcRenderer.invoke("quolldesk:plugins:host-ui-resource", payload),
  openHostDrawnPluginView: (payload) => ipcRenderer.invoke("quolldesk:plugins:host-ui-open", payload),
  closeHostDrawnPluginView: (instanceId) => ipcRenderer.invoke("quolldesk:plugins:host-ui-close", { instanceId }),
  sendHostDrawnPluginViewEvent: (instanceId, event) => ipcRenderer.invoke("quolldesk:plugins:host-ui-event", { instanceId, event }),
  onHostDrawnPluginViewUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("quolldesk:plugins:host-ui-update", listener);
    return () => ipcRenderer.removeListener("quolldesk:plugins:host-ui-update", listener);
  },
  onPluginContributionsChanged: (callback) => {
    pluginContributionsChangedListeners.add(callback);
    return () => pluginContributionsChangedListeners.delete(callback);
  },
  onPluginViewClosed: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("quolldesk:plugins:view-closed", listener);
    return () => ipcRenderer.removeListener("quolldesk:plugins:view-closed", listener);
  },
  getPluginScopeCatalog: () => ipcRenderer.invoke("quolldesk:plugins:get-scope-catalog"),
  setPluginScopeCatalog: (catalog) => ipcRenderer.invoke("quolldesk:plugins:set-scope-catalog", catalog),
  onPluginScopeCatalogChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("quolldesk:plugins:scope-catalog-changed", listener);
    return () => ipcRenderer.removeListener("quolldesk:plugins:scope-catalog-changed", listener);
  },
  getWindowsPtyInfo: () => {
    if (process.platform !== "win32") {
      return null;
    }

    const releaseParts = os.release().split(".");
    const buildNumber = Number.parseInt(releaseParts[2] || "", 10);
    const hasBuildNumber = Number.isFinite(buildNumber);
    const backend =
      hasBuildNumber && buildNumber < 18309 ? "winpty" : "conpty";

    return hasBuildNumber ? { backend, buildNumber } : { backend };
  },
  startSSHSession: async (options) => {
    markRequestedTerminalDataSessionOpen(options);
    const result = await ipcRenderer.invoke("quolldesk:start", options);
    markTerminalDataSessionOpen(result?.sessionId);
    return result.sessionId;
  },
  monitorUpdate: (panels) => ipcRenderer.invoke("quolldesk:monitor:update", panels),
  monitorSnapshot: (cursor) => ipcRenderer.invoke("quolldesk:monitor:snapshot", cursor),
  monitorStopAll: () => ipcRenderer.invoke("quolldesk:monitor:stop-all"),
  monitorRetry: (hostId) => ipcRenderer.invoke("quolldesk:monitor:retry", hostId),
  testConnection: async (options) => {
    const result = await ipcRenderer.invoke("quolldesk:test-connection", options);
    return result.sessionId;
  },
  cancelTestConnection: async (sessionId) => {
    return ipcRenderer.invoke("quolldesk:test-connection:cancel", sessionId);
  },
  startTelnetSession: async (options) => {
    markRequestedTerminalDataSessionOpen(options);
    const result = await ipcRenderer.invoke("quolldesk:telnet:start", options);
    markTerminalDataSessionOpen(result?.sessionId);
    return result.sessionId;
  },
  startMoshSession: async (options) => {
    markRequestedTerminalDataSessionOpen(options);
    const result = await ipcRenderer.invoke("quolldesk:mosh:start", options);
    markTerminalDataSessionOpen(result?.sessionId);
    return result.sessionId;
  },
  startEtSession: async (options) => {
    markRequestedTerminalDataSessionOpen(options);
    const result = await ipcRenderer.invoke("quolldesk:et:start", options);
    markTerminalDataSessionOpen(result?.sessionId);
    return result.sessionId;
  },
  startLocalSession: async (options) => {
    markRequestedTerminalDataSessionOpen(options);
    const result = await ipcRenderer.invoke("quolldesk:local:start", options || {});
    markTerminalDataSessionOpen(result?.sessionId);
    return result.sessionId;
  },
  startSerialSession: async (options) => {
    markRequestedTerminalDataSessionOpen(options);
    const result = await ipcRenderer.invoke("quolldesk:serial:start", options);
    markTerminalDataSessionOpen(result?.sessionId);
    return result.sessionId;
  },
  // ---- Database clients (redis / mysql / postgresql) ----
  connectRedis: async (options) => ipcRenderer.invoke("quolldesk:redis:connect", options),
  disconnectRedis: async (connectionId) => ipcRenderer.invoke("quolldesk:redis:disconnect", { connectionId }),
  testRedisConnection: async (options) => ipcRenderer.invoke("quolldesk:redis:test", options),
  scanRedisKeys: async (args) => ipcRenderer.invoke("quolldesk:redis:scan", args),
  getRedisKeyMeta: async (args) => ipcRenderer.invoke("quolldesk:redis:keyMeta", args),
  getRedisKeyValue: async (args) => ipcRenderer.invoke("quolldesk:redis:keyValue", args),
  getRedisServerInfo: async (args) => ipcRenderer.invoke("quolldesk:redis:serverInfo", args),
  selectRedisDb: async (args) => ipcRenderer.invoke("quolldesk:redis:selectDb", args),
  getRedisKeyTypes: async (args) => ipcRenderer.invoke("quolldesk:redis:keyTypes", args),
  subscribeRedis: async (args) => ipcRenderer.invoke("quolldesk:redis:subscribe", args),
  unsubscribeRedis: async (args) => ipcRenderer.invoke("quolldesk:redis:unsubscribe", args),
  runRedisCommand: async (args) => ipcRenderer.invoke("quolldesk:redis:runCommand", args),
  createRedisKey: async (args) => ipcRenderer.invoke("quolldesk:redis:createKey", args),
  deleteRedisKey: async (args) => ipcRenderer.invoke("quolldesk:redis:deleteKey", args),
  renameRedisKey: async (args) => ipcRenderer.invoke("quolldesk:redis:renameKey", args),
  expireRedisKey: async (args) => ipcRenderer.invoke("quolldesk:redis:expireKey", args),
  setRedisStringValue: async (args) => ipcRenderer.invoke("quolldesk:redis:setStringValue", args),
  addRedisHashField: async (args) => ipcRenderer.invoke("quolldesk:redis:hashSetField", args),
  removeRedisHashField: async (args) => ipcRenderer.invoke("quolldesk:redis:hashDeleteField", args),
  pushRedisList: async (args) => ipcRenderer.invoke("quolldesk:redis:listPush", args),
  removeRedisListValue: async (args) => ipcRenderer.invoke("quolldesk:redis:listRemoveValue", args),
  addRedisSetMember: async (args) => ipcRenderer.invoke("quolldesk:redis:setAddMember", args),
  removeRedisSetMember: async (args) => ipcRenderer.invoke("quolldesk:redis:setRemoveMember", args),
  addRedisZsetMember: async (args) => ipcRenderer.invoke("quolldesk:redis:zsetAddMember", args),
  removeRedisZsetMember: async (args) => ipcRenderer.invoke("quolldesk:redis:zsetRemoveMember", args),
  onRedisPubsubMessage: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on("quolldesk:redis:pubsubMessage", listener);
    return () => { ipcRenderer.removeListener("quolldesk:redis:pubsubMessage", listener); };
  },

  connectMysql: async (options) => ipcRenderer.invoke("quolldesk:mysql:connect", options),
  disconnectMysql: async (connectionId) => ipcRenderer.invoke("quolldesk:mysql:disconnect", { connectionId }),
  testMysqlConnection: async (options) => ipcRenderer.invoke("quolldesk:mysql:test", options),
  getMysqlSchemaTree: async (args) => ipcRenderer.invoke("quolldesk:mysql:schemaTree", args),
  getMysqlTableMeta: async (args) => ipcRenderer.invoke("quolldesk:mysql:tableMeta", args),
  getMysqlTableRows: async (args) => ipcRenderer.invoke("quolldesk:mysql:tableRows", args),
  queryMysql: async (args) => ipcRenderer.invoke("quolldesk:mysql:query", args),
  applyMysqlTableChanges: async (args) => ipcRenderer.invoke("quolldesk:mysql:applyTableChanges", args),

  connectPg: async (options) => ipcRenderer.invoke("quolldesk:pg:connect", options),
  disconnectPg: async (connectionId) => ipcRenderer.invoke("quolldesk:pg:disconnect", { connectionId }),
  testPgConnection: async (options) => ipcRenderer.invoke("quolldesk:pg:test", options),
  getPgSchemaTree: async (args) => ipcRenderer.invoke("quolldesk:pg:schemaTree", args),
  getPgTableMeta: async (args) => ipcRenderer.invoke("quolldesk:pg:tableMeta", args),
  getPgTableRows: async (args) => ipcRenderer.invoke("quolldesk:pg:tableRows", args),
  queryPg: async (args) => ipcRenderer.invoke("quolldesk:pg:query", args),
  applyPgTableChanges: async (args) => ipcRenderer.invoke("quolldesk:pg:applyTableChanges", args),

  // SQL backup/restore (Wave 6): async jobs push progress on the shared
  // quolldesk:db:jobProgress channel (payload carries the dialect).
  pickMysqlBackupPath: async (args) => ipcRenderer.invoke("quolldesk:mysql:pickBackupPath", args),
  pickMysqlRestoreFile: async (args) => ipcRenderer.invoke("quolldesk:mysql:pickRestoreFile", args),
  backupMysql: async (args) => ipcRenderer.invoke("quolldesk:mysql:backup", args),
  restoreMysql: async (args) => ipcRenderer.invoke("quolldesk:mysql:restore", args),
  pickPgBackupPath: async (args) => ipcRenderer.invoke("quolldesk:pg:pickBackupPath", args),
  pickPgRestoreFile: async (args) => ipcRenderer.invoke("quolldesk:pg:pickRestoreFile", args),
  backupPg: async (args) => ipcRenderer.invoke("quolldesk:pg:backup", args),
  restorePg: async (args) => ipcRenderer.invoke("quolldesk:pg:restore", args),
  onDbJobProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on("quolldesk:db:jobProgress", listener);
    return () => { ipcRenderer.removeListener("quolldesk:db:jobProgress", listener); };
  },
  // Main-process-initiated DB connection closes (idle reap / driver death):
  // lets the workbench flip its status dot instead of stranded-green.
  onDbConnectionClosed: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on("quolldesk:db:connectionClosed", listener);
    return () => { ipcRenderer.removeListener("quolldesk:db:connectionClosed", listener); };
  },
  listSerialPorts: async () => {
    return ipcRenderer.invoke("quolldesk:serial:list");
  },
  sendSerialYmodem: async (sessionId, filePath) => {
    return ipcRenderer.invoke("quolldesk:serial:ymodem-send", { sessionId, filePath });
  },
  receiveSerialYmodem: async (sessionId, destinationDir) => {
    return ipcRenderer.invoke("quolldesk:serial:ymodem-receive", { sessionId, destinationDir });
  },
  getDefaultShell: async () => {
    return ipcRenderer.invoke("quolldesk:local:defaultShell");
  },
  discoverShells: () => ipcRenderer.invoke("quolldesk:shells:discover"),
  validatePath: async (path, type) => {
    return ipcRenderer.invoke("quolldesk:local:validatePath", { path, type });
  },
  writeToSession: (sessionId, data, options) => {
    const lineDelayMs = Number(options?.lineDelayMs);
    ipcRenderer.send("quolldesk:write", {
      sessionId,
      data,
      binary: options?.binary === true,
      automated: Boolean(options?.automated),
      pasteRequestId: typeof options?.pasteRequestId === "string" ? options.pasteRequestId : undefined,
      sensitive: options?.sensitive === true,
      serialEraseChar: typeof options?.serialEraseChar === "string" ? options.serialEraseChar : undefined,
      lineDelayMs: Number.isFinite(lineDelayMs) && lineDelayMs > 0 ? lineDelayMs : undefined,
      logRewrite: options?.logRewrite && typeof options.logRewrite === "object"
        ? {
            sentCommand: String(options.logRewrite.sentCommand ?? ""),
            displayCommand: String(options.logRewrite.displayCommand ?? ""),
          }
        : undefined,
    });
  },
  notifySessionUserInput: (sessionId) => {
    ipcRenderer.send("quolldesk:terminal:user-input", { sessionId });
  },
  onTerminalPasteWrite: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on("quolldesk:paste-write", listener);
    return () => ipcRenderer.removeListener("quolldesk:paste-write", listener);
  },
  interruptSession: (sessionId, trace, options) => {
    const sanitizedTrace = sanitizeInterruptTrace(trace);
    if (options?.cancelPendingWritesOnly === true) {
      ipcRenderer.send("quolldesk:interrupt", { sessionId, trace: sanitizedTrace, cancelPendingWritesOnly: true });
      return;
    }
    if (ctx.terminalUrgentInputPorts?.postInterrupt?.(sessionId, sanitizedTrace)) {
      return;
    }
    ipcRenderer.send("quolldesk:interrupt", { sessionId, trace: sanitizedTrace });
  },
  execCommand: async (options) => {
    return ipcRenderer.invoke("quolldesk:ssh:exec", options);
  },
  getSessionPwd: async (sessionId, options) => {
    return ipcRenderer.invoke("quolldesk:ssh:pwd", {
      sessionId,
      allowHomeFallback: options?.allowHomeFallback,
      allowLoginShellFallback: options?.allowLoginShellFallback,
      timeoutMs: options?.timeoutMs,
    });
  },
  getSessionRemoteInfo: async (sessionId) => {
    return ipcRenderer.invoke("quolldesk:ssh:remoteInfo", { sessionId });
  },
  getSessionDistroInfo: async (sessionId) => {
    return ipcRenderer.invoke("quolldesk:ssh:distroInfo", { sessionId });
  },
  getServerStats: async (sessionId) => {
    return ipcRenderer.invoke("quolldesk:ssh:stats", { sessionId });
  },
  probeSystemCapabilities: async (sessionId) => {
    return ipcRenderer.invoke("quolldesk:system:probeCapabilities", { sessionId });
  },
  listSystemProcesses: async (sessionId) => {
    return ipcRenderer.invoke("quolldesk:system:listProcesses", { sessionId });
  },
  signalSystemProcess: async (options) => {
    return ipcRenderer.invoke("quolldesk:system:signalProcess", options);
  },
  setupOsc7Tracking: async (sessionId, command) => {
    return ipcRenderer.invoke("quolldesk:system:setupOsc7Tracking", { sessionId, command });
  },
  listTmuxSessions: async (sessionId) => {
    return ipcRenderer.invoke("quolldesk:system:listTmuxSessions", { sessionId });
  },
  createTmuxSession: async (options) => {
    return ipcRenderer.invoke("quolldesk:system:createTmuxSession", options);
  },
  listTmuxWindows: async (options) => {
    return ipcRenderer.invoke("quolldesk:system:listTmuxWindows", options);
  },
  listTmuxPanes: async (options) => {
    return ipcRenderer.invoke("quolldesk:system:listTmuxPanes", options);
  },
  listTmuxClients: async (options) => {
    return ipcRenderer.invoke("quolldesk:system:listTmuxClients", options);
  },
  tmuxAction: async (options) => {
    return ipcRenderer.invoke("quolldesk:system:tmuxAction", options);
  },
  listDockerContainers: async (sessionId, runtime) => {
    return ipcRenderer.invoke("quolldesk:system:listDockerContainers", { sessionId, runtime });
  },
  listDockerImages: async (sessionId, runtime) => {
    return ipcRenderer.invoke("quolldesk:system:listDockerImages", { sessionId, runtime });
  },
  getDockerStats: async (options) => {
    return ipcRenderer.invoke("quolldesk:system:dockerStats", options);
  },
  listAccelerators: async (sessionId) => {
    return ipcRenderer.invoke("quolldesk:system:listAccelerators", { sessionId });
  },
  listListeningPorts: async (sessionId) => {
    return ipcRenderer.invoke("quolldesk:system:listListeningPorts", { sessionId });
  },
  listSystemServices: async (sessionId) => {
    return ipcRenderer.invoke("quolldesk:system:listSystemServices", { sessionId });
  },
  systemServiceAction: async (options) => {
    return ipcRenderer.invoke("quolldesk:system:systemServiceAction", options);
  },
  dockerInspect: async (options) => {
    return ipcRenderer.invoke("quolldesk:system:dockerInspect", options);
  },
  dockerImageInspect: async (options) => {
    return ipcRenderer.invoke("quolldesk:system:dockerImageInspect", options);
  },
  dockerAction: async (options) => {
    return ipcRenderer.invoke("quolldesk:system:dockerAction", options);
  },
  dockerImageAction: async (options) => {
    return ipcRenderer.invoke("quolldesk:system:dockerImageAction", options);
  },
  kubectl: async (options) => {
    return ipcRenderer.invoke("quolldesk:system:kubectl", options);
  },
  openTerminalPopup: async (payload) => {
    return ipcRenderer.invoke("quolldesk:window:openTerminalPopup", payload);
  },
  logDiagnostic: async (payload) => {
    return ipcRenderer.invoke("quolldesk:diagnostics:log", payload);
  },
  onTerminalPopupConfig: (cb) => {
    terminalPopupConfigState.listeners.add(cb);
    const replay = terminalPopupConfigState.pending ?? terminalPopupConfigState.lastPayload;
    if (replay) {
      // Drain the one-shot pending slot once a live subscriber exists, but keep
      // lastPayload so remounts (AppLockGate delay, StrictMode) can resubscribe
      // and still receive the one-shot main post-loadURL payload.
      terminalPopupConfigState.pending = null;
      queueMicrotask(() => {
        try {
          cb(replay);
        } catch (err) {
          console.error("Terminal popup config callback failed", err);
        }
      });
    }
    return () => terminalPopupConfigState.listeners.delete(cb);
  },
  readRemoteHistory: async (sessionId, limit) => {
    return ipcRenderer.invoke("quolldesk:ssh:readRemoteHistory", { sessionId, limit });
  },
  generateKeyPair: async (options) => {
    return ipcRenderer.invoke("quolldesk:key:generate", options);
  },
  checkSshAgent: async (options) => {
    return ipcRenderer.invoke("quolldesk:ssh:check-agent", options);
  },
  getDefaultKeys: async () => {
    return ipcRenderer.invoke("quolldesk:ssh:get-default-keys");
  },
  resizeSession: (sessionId, cols, rows) => {
    ipcRenderer.send("quolldesk:resize", { sessionId, cols, rows });
  },
  clearSessionPtyBuffer: (sessionId) => {
    if (!sessionId) return;
    ipcRenderer.send("quolldesk:pty:clear", { sessionId });
  },
  setSessionFlowPaused: (sessionId, paused) => {
    ipcRenderer.send("quolldesk:flow", { sessionId, paused: Boolean(paused) });
  },
  setSessionFlowPausedAndWait: (sessionId, paused) =>
    ipcRenderer.invoke("quolldesk:terminal:setFlowPausedAndWait", {
      sessionId,
      paused: Boolean(paused),
    }),
  acquireSessionFlowPauseLease: (sessionId) =>
    ipcRenderer.invoke("quolldesk:terminal:acquireFlowPauseLease", { sessionId }),
  waitSessionFlowPauseLease: (sessionId, leaseId) =>
    ipcRenderer.invoke("quolldesk:terminal:waitFlowPauseLease", { sessionId, leaseId }),
  releaseSessionFlowPauseLease: (sessionId, leaseId, options) =>
    ipcRenderer.invoke("quolldesk:terminal:releaseFlowPauseLease", {
      sessionId,
      leaseId,
      keepPaused: options?.keepPaused === true,
    }),
  onTerminalOutputDrainRequest: (sessionId, cb) => {
    const listeners = ctx.terminalOutputDrainListeners;
    if (!listeners.has(sessionId)) listeners.set(sessionId, new Set());
    listeners.get(sessionId).add(cb);
    return () => {
      const set = listeners.get(sessionId);
      set?.delete(cb);
      if (set?.size === 0) listeners.delete(sessionId);
    };
  },
  respondTerminalOutputDrain: (requestId) => {
    ipcRenderer.send("quolldesk:terminal:output-drain-response", { requestId });
  },
  notifyTerminalSessionDisplayReady: (sessionId) => {
    ipcRenderer.send("quolldesk:terminal:display-ready", { sessionId });
  },
  ackSessionFlow: (sessionId, bytes) => {
    if (!sessionId || !Number.isFinite(bytes) || bytes <= 0) return;
    ipcRenderer.send("quolldesk:flow:ack", { sessionId, bytes });
  },
  closeSession: async (sessionId, options) => {
    const payload = {
      sessionId,
      ...(Number.isFinite(options?.bootEpoch) ? { bootEpoch: Number(options.bootEpoch) } : {}),
      ...(options?.retainOwnership === true ? { retainOwnership: true } : {}),
    };
    const epochScoped = Number.isFinite(options?.bootEpoch);
    // Unscoped closes keep the historical sync listener teardown so reconnect
    // paths that fire-and-forget closeSession still drop stale handlers.
    // Epoch-scoped closes are only used to dispose a superseded backend owner;
    // they must never clear preload listeners for the shared sessionId, because
    // a replacement boot may already have registered readiness/auto-login hooks.
    if (!epochScoped) {
      markTerminalDataSessionClosed(sessionId);
      clearSessionScopedTerminalListeners(sessionId);
    }
    try {
      await ipcRenderer.invoke("quolldesk:close:await", payload);
    } catch {
      ipcRenderer.send("quolldesk:close", payload);
    }
  },
  rebindTerminalSessionOutput: (sessionId, authorization) =>
    ipcRenderer.invoke("quolldesk:terminal:rebindOutput", { sessionId, authorization }),
  restoreTerminalSessionOutput: (sessionId, webContentsId, authorization) =>
    ipcRenderer.invoke("quolldesk:terminal:restoreOutput", { sessionId, webContentsId, authorization }),
  requestTerminalSessionSnapshot: (sessionId, authorization) =>
    ipcRenderer.invoke("quolldesk:terminal:requestSnapshot", { sessionId, authorization }),
  onTerminalSessionSnapshotRequest: (cb) => {
    const handler = (_event, payload) => {
      try {
        cb?.(payload);
      } catch {
        // Provider failures must not break the main process request.
      }
    };
    ipcRenderer.on("quolldesk:terminal:snapshot-request", handler);
    return () => ipcRenderer.removeListener("quolldesk:terminal:snapshot-request", handler);
  },
  respondTerminalSessionSnapshot: (
    requestId,
    snapshot,
    kittyKeyboardModeState,
    kittyKeyboardProtocolEnabled,
    passwordPromptActive,
    cwd,
    title,
    perCharacterInput,
  ) => {
    ipcRenderer.send("quolldesk:terminal:snapshot-response", {
      requestId,
      snapshot: typeof snapshot === "string" ? snapshot : "",
      perCharacterInput: typeof perCharacterInput === "boolean" ? perCharacterInput : undefined,
      kittyKeyboardModeState: sanitizeKittyKeyboardModeState(kittyKeyboardModeState),
      kittyKeyboardProtocolEnabled: typeof kittyKeyboardProtocolEnabled === "boolean"
        ? kittyKeyboardProtocolEnabled
        : undefined,
      passwordPromptActive: typeof passwordPromptActive === "boolean"
        ? passwordPromptActive
        : undefined,
      cwd: cwd === null ? null : typeof cwd === "string" ? cwd : undefined,
      title: title === null ? null : typeof title === "string" ? title : undefined,
    });
  },
  applyTerminalSessionSnapshot: (sessionId, snapshot, context, authorization) =>
    ipcRenderer.invoke("quolldesk:terminal:applySnapshot", {
      sessionId,
      snapshot: typeof snapshot === "string" ? snapshot : "",
      contextSnapshot: typeof context?.contextSnapshot === "string" ? context.contextSnapshot : "",
      contextViewportSnapshot: typeof context?.contextViewportSnapshot === "string"
        ? context.contextViewportSnapshot
        : "",
      contextScrollbackSnapshot: typeof context?.contextScrollbackSnapshot === "string"
        ? context.contextScrollbackSnapshot
        : "",
      alternateScreen: context?.alternateScreen === true,
      perCharacterInput: typeof context?.perCharacterInput === "boolean"
        ? context.perCharacterInput
        : undefined,
      kittyKeyboardModeState: sanitizeKittyKeyboardModeState(context?.kittyKeyboardModeState),
      kittyKeyboardProtocolEnabled: typeof context?.kittyKeyboardProtocolEnabled === "boolean"
        ? context.kittyKeyboardProtocolEnabled
        : undefined,
      passwordPromptActive: typeof context?.passwordPromptActive === "boolean"
        ? context.passwordPromptActive
        : undefined,
      cwd: context?.cwd === null ? null : typeof context?.cwd === "string" ? context.cwd : undefined,
      title: context?.title === null ? null : typeof context?.title === "string" ? context.title : undefined,
      authorization,
    }),
  markAttachPopupClosePrepared: (sessionId, authorization) =>
    ipcRenderer.invoke("quolldesk:terminal:markAttachClosePrepared", { sessionId, authorization }),
  onTerminalPopupPrepareClose: (cb) => {
    const handler = (_event, payload) => cb?.(payload);
    ipcRenderer.on("quolldesk:terminal-popup:prepare-close", handler);
    return () => ipcRenderer.removeListener("quolldesk:terminal-popup:prepare-close", handler);
  },
  onTerminalSessionApplySnapshot: (cb) => {
    const handler = (_event, payload) => {
      Promise.resolve().then(() => cb?.(payload)).then(
        (handled) => {
          if (handled !== true) return;
          ipcRenderer.send("quolldesk:terminal:apply-snapshot-response", {
            requestId: payload?.requestId,
            success: true,
          });
        },
        (err) => ipcRenderer.send("quolldesk:terminal:apply-snapshot-response", {
          requestId: payload?.requestId,
          success: false,
          error: err?.message || String(err),
        }),
      );
    };
    ipcRenderer.on("quolldesk:terminal:apply-snapshot", handler);
    return () => ipcRenderer.removeListener("quolldesk:terminal:apply-snapshot", handler);
  },
  setSessionEncoding: async (sessionId, encoding) => {
    // Try the SSH handler first; it returns { ok: false } for non-SSH
    // sessions (no session.stream). Telnet and serial sessions fall
    // through to terminalBridge's handler.
    const ssh = await ipcRenderer.invoke("quolldesk:ssh:setEncoding", { sessionId, encoding });
    if (ssh?.ok) return ssh;
    return ipcRenderer.invoke("quolldesk:terminal:setEncoding", { sessionId, encoding });
  },
  onZmodemEvent: (sessionId, cb) => {
    if (!zmodemListeners.has(sessionId)) zmodemListeners.set(sessionId, new Set());
    zmodemListeners.get(sessionId).add(cb);
    return () => {
      const set = zmodemListeners.get(sessionId);
      if (!set) return;
      set.delete(cb);
      if (set.size === 0) zmodemListeners.delete(sessionId);
    };
  },
  cancelZmodem: (sessionId, options) => {
    ipcRenderer.send("quolldesk:zmodem:cancel", { sessionId, options });
  },
  startZmodemDragDropUpload: (sessionId, files, uploadCommand) => {
    return ipcRenderer.invoke("quolldesk:zmodem:drag-drop-upload", {
      sessionId,
      files,
      uploadCommand,
    });
  },
  onZmodemOverwriteRequest: (sessionId, cb) => {
    if (!zmodemOverwriteListeners.has(sessionId)) zmodemOverwriteListeners.set(sessionId, new Set());
    zmodemOverwriteListeners.get(sessionId).add(cb);
    return () => {
      const set = zmodemOverwriteListeners.get(sessionId);
      if (!set) return;
      set.delete(cb);
      if (set.size === 0) zmodemOverwriteListeners.delete(sessionId);
    };
  },
  respondZmodemOverwrite: (payload) => {
    ipcRenderer.send("quolldesk:zmodem:overwrite-response", payload);
  },
  onSessionData: (sessionId, cb, options) => {
    const replayBacklog = options?.replayBacklog === true;
    if (!dataListeners.has(sessionId)) dataListeners.set(sessionId, new Set());
    dataListeners.get(sessionId).add(cb);
    if (replayBacklog) {
      if (!displayDataListeners.has(sessionId)) displayDataListeners.set(sessionId, new Set());
      displayDataListeners.get(sessionId).add(cb);
      const pendingEntry = terminalDataBacklog?.takeEntry?.(sessionId)
        ?? { data: terminalDataBacklog?.take?.(sessionId) || "", meta: undefined };
      if (pendingEntry.data || hasPluginPipelineIngressMarker(pendingEntry.meta)) {
        try {
          cb(pendingEntry.data, pendingEntry.meta);
        } catch (err) {
          console.error("Data callback failed", err);
        }
      }
    }
    return () => {
      const dataSet = dataListeners.get(sessionId);
      dataSet?.delete(cb);
      if (dataSet?.size === 0) dataListeners.delete(sessionId);

      if (!replayBacklog) return;
      const displaySet = displayDataListeners.get(sessionId);
      displaySet?.delete(cb);
      if (displaySet?.size === 0) displayDataListeners.delete(sessionId);
    };
  },
  onSessionExit: (sessionId, cb) => {
    if (!exitListeners.has(sessionId)) exitListeners.set(sessionId, new Set());
    exitListeners.get(sessionId).add(cb);
    return () => {
      const set = exitListeners.get(sessionId);
      set?.delete(cb);
      if (set?.size === 0) exitListeners.delete(sessionId);
    };
  },
  onTelnetAutoLoginComplete: (sessionId, cb) => {
    if (!telnetAutoLoginCompleteListeners.has(sessionId)) {
      telnetAutoLoginCompleteListeners.set(sessionId, new Set());
    }
    telnetAutoLoginCompleteListeners.get(sessionId).add(cb);
    return () => removeSessionListener(telnetAutoLoginCompleteListeners, sessionId, cb);
  },
  onTelnetAutoLoginCancelled: (sessionId, cb) => {
    if (!telnetAutoLoginCancelledListeners.has(sessionId)) {
      telnetAutoLoginCancelledListeners.set(sessionId, new Set());
    }
    telnetAutoLoginCancelledListeners.get(sessionId).add(cb);
    return () => removeSessionListener(telnetAutoLoginCancelledListeners, sessionId, cb);
  },
  onMoshSessionReady: (sessionId, cb) => {
    if (!moshSessionReadyListeners.has(sessionId)) {
      moshSessionReadyListeners.set(sessionId, new Set());
    }
    moshSessionReadyListeners.get(sessionId).add(cb);
    return () => removeSessionListener(moshSessionReadyListeners, sessionId, cb);
  },
  onTelnetEchoMode: (sessionId, cb) => {
    if (!telnetEchoModeListeners.has(sessionId)) {
      telnetEchoModeListeners.set(sessionId, new Set());
    }
    telnetEchoModeListeners.get(sessionId).add(cb);
    return () => removeSessionListener(telnetEchoModeListeners, sessionId, cb);
  },
  getTelnetEchoMode: (sessionId) =>
    ipcRenderer.invoke("quolldesk:telnet:getEchoMode", { sessionId }),
  onAuthFailed: (sessionId, cb) => {
    if (!authFailedListeners.has(sessionId)) authFailedListeners.set(sessionId, new Set());
    authFailedListeners.get(sessionId).add(cb);
    return () => removeSessionListener(authFailedListeners, sessionId, cb);
  },
  // Keyboard-interactive authentication (2FA/MFA)
  onKeyboardInteractive: (cb) => {
    keyboardInteractiveListeners.add(cb);
    return () => keyboardInteractiveListeners.delete(cb);
  },
  onKeyboardInteractiveCancelled: (cb) => {
    keyboardInteractiveCancelledListeners.add(cb);
    return () => keyboardInteractiveCancelledListeners.delete(cb);
  },
  respondKeyboardInteractive: async (requestId, responses, cancelled = false) => {
    return ipcRenderer.invoke("quolldesk:keyboard-interactive:respond", {
      requestId,
      responses,
      cancelled,
    });
  },
  onHostKeyVerification: (cb) => {
    hostKeyVerificationListeners.add(cb);
    return () => hostKeyVerificationListeners.delete(cb);
  },
  respondHostKeyVerification: async (requestId, accept, addToKnownHosts = false) => {
    return ipcRenderer.invoke("quolldesk:host-key:respond", {
      requestId,
      accept,
      addToKnownHosts,
    });
  },
  // Passphrase request for encrypted SSH keys
  onPassphraseRequest: (cb) => {
    passphraseListeners.add(cb);
    return () => passphraseListeners.delete(cb);
  },
  respondPassphrase: async (requestId, passphrase, cancelled = false) => {
    return ipcRenderer.invoke("quolldesk:passphrase:respond", {
      requestId,
      passphrase,
      cancelled,
    });
  },
  respondPassphraseSkip: async (requestId) => {
    return ipcRenderer.invoke("quolldesk:passphrase:respond", {
      requestId,
      passphrase: '',
      skipped: true,
    });
  },
  onPassphraseTimeout: (cb) => {
    passphraseTimeoutListeners.add(cb);
    return () => passphraseTimeoutListeners.delete(cb);
  },
  onPassphraseCancelled: (cb) => {
    passphraseCancelledListeners.add(cb);
    return () => passphraseCancelledListeners.delete(cb);
  },
  onPassphraseAuthFailed: (cb) => {
    passphraseAuthFailedListeners.add(cb);
    return () => passphraseAuthFailedListeners.delete(cb);
  },
  // FIDO2 PIN / touch presence prompts
  onFidoPromptRequest: (cb) => {
    fidoPromptListeners.add(cb);
    return () => fidoPromptListeners.delete(cb);
  },
  respondFidoPrompt: async (requestId, response, cancelled = false) => {
    return ipcRenderer.invoke("quolldesk:fido-prompt:respond", {
      requestId,
      response,
      cancelled,
    });
  },
  onFidoPromptTimeout: (cb) => {
    fidoPromptTimeoutListeners.add(cb);
    return () => fidoPromptTimeoutListeners.delete(cb);
  },
  onFidoPromptCancelled: (cb) => {
    fidoPromptCancelledListeners.add(cb);
    return () => fidoPromptCancelledListeners.delete(cb);
  },
  openSftp: async (options) => {
      const result = await ipcRenderer.invoke("quolldesk:sftp:open", options);
      return result.sftpId;
    },
  openSftpForSession: async (sessionId, options) => {
    const result = await ipcRenderer.invoke("quolldesk:sftp:openForSession", {
      ...(options || {}),
      sessionId,
      expectedEndpoint: options?.reuseExactSessionOnly === true ? undefined : options,
    });
    if (
      (options?.requireExactSourceSession === true || options?.reuseExactSessionOnly === true)
      && result.sourceSessionId !== sessionId
    ) {
      if (result.sftpId) {
        try {
          await ipcRenderer.invoke("quolldesk:sftp:close", { sftpId: result.sftpId });
        } catch {
          // Best-effort cleanup before rejecting an invalid strict binding.
        }
      }
      throw new Error("The requested terminal connection is no longer available");
    }
    return result.sftpId;
  },
  listSftp: async (sftpId, path, encoding) => {
    return ipcRenderer.invoke("quolldesk:sftp:list", { sftpId, path, encoding });
  },
  realpathSftp: async (sftpId, path, encoding) => {
    return ipcRenderer.invoke("quolldesk:sftp:realpath", { sftpId, path, encoding });
  },
  readSftp: async (sftpId, path, encoding) => {
    return ipcRenderer.invoke("quolldesk:sftp:read", { sftpId, path, encoding });
  },
  readSftpBinary: async (sftpId, path, encoding) => {
    return ipcRenderer.invoke("quolldesk:sftp:readBinary", { sftpId, path, encoding });
  },
  writeSftp: async (sftpId, path, content, encoding) => {
    return ipcRenderer.invoke("quolldesk:sftp:write", { sftpId, path, content, encoding });
  },
  writeSftpBinary: async (sftpId, path, content, encoding) => {
    return ipcRenderer.invoke("quolldesk:sftp:writeBinary", { sftpId, path, content, encoding });
  },
  closeSftp: async (sftpId) => {
    return ipcRenderer.invoke("quolldesk:sftp:close", { sftpId });
  },
  retainSftpTransferSession: async (sftpId, leaseId) => {
    return ipcRenderer.invoke("quolldesk:transfer:retain-sftp-session", { sftpId, leaseId });
  },
  releaseSftpTransferSession: async (sftpId, leaseId) => {
    return ipcRenderer.invoke("quolldesk:transfer:release-sftp-session", { sftpId, leaseId });
  },
  mkdirSftp: async (sftpId, path, encoding) => {
    return ipcRenderer.invoke("quolldesk:sftp:mkdir", { sftpId, path, encoding });
  },
  deleteSftp: async (sftpId, path, encoding, expectedType) => {
    return ipcRenderer.invoke("quolldesk:sftp:delete", { sftpId, path, encoding, expectedType });
  },
  renameSftp: async (sftpId, oldPath, newPath, encoding) => {
    return ipcRenderer.invoke("quolldesk:sftp:rename", { sftpId, oldPath, newPath, encoding });
  },
  statSftp: async (sftpId, path, encoding) => {
    return ipcRenderer.invoke("quolldesk:sftp:stat", { sftpId, path, encoding });
  },
  lstatSftp: async (sftpId, path, encoding) => {
    return ipcRenderer.invoke("quolldesk:sftp:lstat", { sftpId, path, encoding });
  },
  chmodSftp: async (sftpId, path, mode, encoding) => {
    return ipcRenderer.invoke("quolldesk:sftp:chmod", { sftpId, path, mode, encoding });
  },
  extractSftpArchive: async (sftpId, path, encoding) => {
    return ipcRenderer.invoke("quolldesk:sftp:extract", { sftpId, path, encoding });
  },
  createSftpArchive: async (sftpId, options, encoding) => {
    return ipcRenderer.invoke("quolldesk:sftp:createArchive", { sftpId, options, encoding });
  },
  getSftpHomeDir: async (sftpId, encoding) => {
    return ipcRenderer.invoke("quolldesk:sftp:homeDir", { sftpId, encoding });
  },
  // Local filesystem operations
  listLocalDir: async (path) => {
    return ipcRenderer.invoke("quolldesk:local:list", { path });
  },
  readLocalFile: async (path, options) => {
    return ipcRenderer.invoke("quolldesk:local:read", {
      path,
      maxBytes: options?.maxBytes,
    });
  },
  writeLocalFile: async (path, content) => {
    return ipcRenderer.invoke("quolldesk:local:write", { path, content });
  },
  deleteLocalFile: async (path, expectedType) => {
    return ipcRenderer.invoke("quolldesk:local:delete", { path, expectedType });
  },
  renameLocalFile: async (oldPath, newPath) => {
    return ipcRenderer.invoke("quolldesk:local:rename", { oldPath, newPath });
  },
  extractLocalArchive: async (path) => {
    return ipcRenderer.invoke("quolldesk:local:extract", { path });
  },
  mkdirLocal: async (path) => {
    return ipcRenderer.invoke("quolldesk:local:mkdir", { path });
  },
  statLocal: async (path) => {
    return ipcRenderer.invoke("quolldesk:local:stat", { path });
  },
  lstatLocal: async (path) => {
    return ipcRenderer.invoke("quolldesk:local:lstat", { path });
  },
  realpathLocal: async (path) => {
    return ipcRenderer.invoke("quolldesk:local:realpath", { path });
  },
  listLocalTree: async (path, options = {}) => {
    const onProgress = typeof options?.onProgress === "function" ? options.onProgress : null;
    const onEntries = typeof options?.onEntries === "function" ? options.onEntries : null;
    const token = typeof options?.scanId === "string" && options.scanId
      ? options.scanId
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const progressChannel = onProgress
      ? `quolldesk:local:tree-progress:${token}`
      : undefined;
    const entriesChannel = onEntries
      ? `quolldesk:local:tree-entries:${token}`
      : undefined;
    const cancelChannel = `quolldesk:local:tree-cancel:${token}`;
    const progressHandler = onProgress && progressChannel
      ? (_event, stats) => {
        try {
          onProgress(stats);
        } catch {
          // Ignore renderer progress handler errors so the scan can finish.
        }
      }
      : null;
    // Entry batches arrive on a different channel than the invoke reply. If we
    // tear down the listener when invoke resolves, nested-folder batches that
    // are still in the IPC queue are dropped (top-level files look fine).
    let settleEntriesStream = null;
    const entriesStreamDone = onEntries && entriesChannel
      ? new Promise((resolve) => {
        settleEntriesStream = resolve;
      })
      : null;
    const entriesHandler = onEntries && entriesChannel
      ? (_event, payload) => {
        if (payload && typeof payload === "object" && !Array.isArray(payload) && payload.type === "tree-end") {
          settleEntriesStream?.();
          return;
        }
        try {
          if (Array.isArray(payload)) onEntries(payload);
        } catch {
          // Ignore batch handler errors so the scan can finish.
        }
      }
      : null;
    if (progressHandler && progressChannel) {
      ipcRenderer.on(progressChannel, progressHandler);
    }
    if (entriesHandler && entriesChannel) {
      ipcRenderer.on(entriesChannel, entriesHandler);
    }
    try {
      const result = await ipcRenderer.invoke("quolldesk:local:tree", {
        path,
        progressChannel,
        entriesChannel,
        cancelChannel,
        limits: options?.limits,
      });
      if (entriesStreamDone) {
        // Wait for the main-process end marker so late nested batches are not
        // lost. Fail the scan if the marker never arrives (do not pretend a
        // partial tree is complete).
        let timedOut = false;
        await Promise.race([
          entriesStreamDone,
          new Promise((resolve) => {
            setTimeout(() => {
              timedOut = true;
              resolve();
            }, 5_000);
          }),
        ]);
        if (timedOut) {
          throw new Error("Local tree scan ended without a completion marker");
        }
      }
      return result;
    } finally {
      settleEntriesStream?.();
      if (progressHandler && progressChannel) {
        ipcRenderer.removeListener(progressChannel, progressHandler);
      }
      if (entriesHandler && entriesChannel) {
        ipcRenderer.removeListener(entriesChannel, entriesHandler);
      }
    }
  },
  cancelLocalTreeScan: async (scanId) => {
    if (typeof scanId === "string" && scanId) {
      ipcRenderer.send(`quolldesk:local:tree-cancel:${scanId}`);
    }
  },
  getHomeDir: async () => {
    return ipcRenderer.invoke("quolldesk:local:homedir");
  },
  listDrives: async () => {
    return ipcRenderer.invoke("quolldesk:local:drives");
  },
  getSystemInfo: async () => {
    return ipcRenderer.invoke("quolldesk:system:info");
  },
  // Read system known_hosts file
  readKnownHosts: async () => {
    return ipcRenderer.invoke("quolldesk:known-hosts:read");
  },
  setTheme: async (theme) => {
    return ipcRenderer.invoke("quolldesk:setTheme", theme);
  },
  setBackgroundColor: async (color) => {
    return ipcRenderer.invoke("quolldesk:setBackgroundColor", color);
  },
  setWindowOpacity: async (opacity) => {
    return ipcRenderer.invoke("quolldesk:setWindowOpacity", opacity);
  },
  setWindowBackgroundBlur: async (enabled) => {
    return ipcRenderer.invoke("quolldesk:setWindowBackgroundBlur", enabled);
  },
  setLanguage: async (language) => {
    return ipcRenderer.invoke("quolldesk:setLanguage", language);
  },
  onLanguageChanged: (cb) => {
    languageChangeListeners.add(cb);
    return () => languageChangeListeners.delete(cb);
  },
  // Transfer state is delivered only through onGlobalSftpTransferEvent.
  startStreamTransfer: async (options) => ipcRenderer.invoke("quolldesk:transfer:start", options),
  cancelTransfer: async (transferId) => {
    return ipcRenderer.invoke("quolldesk:transfer:cancel", { transferId });
  },
  clearPendingTransferCancel: async (transferId) => {
    return ipcRenderer.invoke("quolldesk:transfer:clear-pending-cancel", { transferId });
  },
  pauseTransfer: async (transferId) => {
    return ipcRenderer.invoke("quolldesk:transfer:pause", { transferId });
  },
  resumeTransfer: async (transferId) => {
    return ipcRenderer.invoke("quolldesk:transfer:resume", { transferId });
  },
  prioritizeTransfer: async (transferId) => {
    return ipcRenderer.invoke("quolldesk:transfer:prioritize", { transferId });
  },
  setGlobalTransferConcurrency: async (limit) => {
    return ipcRenderer.invoke("quolldesk:transfer:set-concurrency", { limit });
  },
  cleanupTransferArtifacts: async (payload) => {
    return ipcRenderer.invoke("quolldesk:transfer:cleanup", payload);
  },
  onGlobalSftpTransferEvent: (callback) => {
    globalSftpTransferListeners.add(callback);
    return () => globalSftpTransferListeners.delete(callback);
  },
  sameHostCopyDirectory: async (sftpId, sourcePath, targetPath, encoding, transferId) => {
    return ipcRenderer.invoke("quolldesk:transfer:same-host-copy-dir", { sftpId, sourcePath, targetPath, encoding, transferId });
  },
  // Compressed folder upload
  startCompressedUpload: async (options) => {
    return ipcRenderer.invoke("quolldesk:compress:start", options);
  },
  cancelCompressedUpload: async (compressionId) => {
    return ipcRenderer.invoke("quolldesk:compress:cancel", { compressionId });
  },
  pauseCompressedUpload: async (compressionId) => {
    return ipcRenderer.invoke("quolldesk:compress:pause", { compressionId });
  },
  resumeCompressedUpload: async (compressionId) => {
    return ipcRenderer.invoke("quolldesk:compress:resume", { compressionId });
  },
  checkCompressedUploadSupport: async (sftpId) => {
    return ipcRenderer.invoke("quolldesk:compress:checkSupport", { sftpId });
  },
  // Window controls for custom title bar
  windowMinimize: () => ipcRenderer.invoke("quolldesk:window:minimize"),
  windowMaximize: () => ipcRenderer.invoke("quolldesk:window:maximize"),
  windowClose: () => ipcRenderer.invoke("quolldesk:window:close"),
  windowIsMaximized: () => ipcRenderer.invoke("quolldesk:window:isMaximized"),
  windowIsFullscreen: () => ipcRenderer.invoke("quolldesk:window:isFullscreen"),
  windowFocus: () => ipcRenderer.invoke("quolldesk:window:focus"),
  setTerminalKeyboardFocus: (focused) => ipcRenderer.send(
    "quolldesk:window:set-terminal-keyboard-focus",
    { focused: focused === true },
  ),
  setWindowTitle: (title) => ipcRenderer.invoke("quolldesk:window:setTitle", title),
  openSessionInNewWindow: (payload) => ipcRenderer.invoke("quolldesk:window:openSession", payload),
  openEditorWindow: (payload) => ipcRenderer.invoke("quolldesk:window:openEditor", payload),
  focusEditorWindow: (editorId) => ipcRenderer.invoke("quolldesk:window:focusEditor", { editorId }),
  closeEditorWindowTabs: (payload) => ipcRenderer.invoke("quolldesk:window:closeEditorTabs", payload),
  saveEditorWindowTab: (payload) => ipcRenderer.invoke("quolldesk:editorWindow:save", payload),
  dockEditorWindowTab: (payload) => ipcRenderer.invoke("quolldesk:editorWindow:dock", payload),
  reportEditorWindowDirty: (payload) => ipcRenderer.send("quolldesk:editorWindow:dirty", payload),
  reportEditorWindowTabsClosed: (payload) => ipcRenderer.send("quolldesk:editorWindow:tabsClosed", payload),
  remapEditorWindowSession: (payload) => ipcRenderer.send("quolldesk:editorWindow:remapSession", payload),
  onEditorWindowOpenTab: (cb) => {
    const editorOpenTabState = ctx.editorOpenTabState || { pending: [], listeners: new Set() };
    const receive = (payload) => {
      try {
        cb(payload);
        ipcRenderer.send("quolldesk:window:editorOpenTabResult", { requestId: payload.requestId, ok: true });
      } catch (err) {
        ipcRenderer.send("quolldesk:window:editorOpenTabResult", {
          requestId: payload.requestId,
          ok: false,
          error: err?.message || "Failed to open editor tab",
        });
      }
    };
    editorOpenTabState.listeners.add(receive);
    // Drain only to the currently mounted receiver. Deferring this would let
    // StrictMode cleanup leave a stale callback holding the transfer.
    for (const payload of editorOpenTabState.pending.splice(0)) receive(payload);
    ipcRenderer.send("quolldesk:window:editorReady");
    return () => editorOpenTabState.listeners.delete(receive);
  },
  onEditorWindowActivateTab: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("quolldesk:window:editorActivateTab", handler);
    return () => ipcRenderer.removeListener("quolldesk:window:editorActivateTab", handler);
  },
  onEditorWindowCloseTabs: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("quolldesk:window:editorCloseTabs", handler);
    return () => ipcRenderer.removeListener("quolldesk:window:editorCloseTabs", handler);
  },
  reportEditorWindowCloseTabsResult: (payload) => {
    ipcRenderer.send("quolldesk:window:editorCloseTabsResult", payload);
  },
  onEditorWindowRemapSession: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("quolldesk:window:editorRemapSession", handler);
    return () => ipcRenderer.removeListener("quolldesk:window:editorRemapSession", handler);
  },
  onEditorWindowSaveRequest: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("quolldesk:window:editorSaveRequest", handler);
    return () => ipcRenderer.removeListener("quolldesk:window:editorSaveRequest", handler);
  },
  reportEditorWindowSaveResult: (payload) => {
    ipcRenderer.send("quolldesk:window:editorSaveResult", payload);
  },
  onEditorWindowDockRequest: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("quolldesk:window:editorDockRequest", handler);
    return () => ipcRenderer.removeListener("quolldesk:window:editorDockRequest", handler);
  },
  reportEditorWindowDockResult: (payload) => {
    ipcRenderer.send("quolldesk:window:editorDockResult", payload);
  },
  onEditorWindowDirtyChanged: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("quolldesk:window:editorDirtyChanged", handler);
    return () => ipcRenderer.removeListener("quolldesk:window:editorDirtyChanged", handler);
  },
  onEditorWindowTabsClosed: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("quolldesk:window:editorTabsClosed", handler);
    return () => ipcRenderer.removeListener("quolldesk:window:editorTabsClosed", handler);
  },
  onOpenSessionInNewWindow: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("quolldesk:window:openSession", handler);
    return () => ipcRenderer.removeListener("quolldesk:window:openSession", handler);
  },
  onWindowCommandCloseRequested: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("quolldesk:window:command-close", handler);
    return () => ipcRenderer.removeListener("quolldesk:window:command-close", handler);
  },
  onWindowFullScreenChanged: (cb) => {
    fullscreenChangeListeners.add(cb);
    return () => fullscreenChangeListeners.delete(cb);
  },
  onWindowShown: (cb) => {
    windowShownListeners.add(cb);
    return () => windowShownListeners.delete(cb);
  },
  onWindowFocusRequested: (cb) => {
    windowFocusRequestedListeners.add(cb);
    return () => windowFocusRequestedListeners.delete(cb);
  },
  onWindowWillHide: (cb) => {
    windowWillHideListeners.add(cb);
    return () => windowWillHideListeners.delete(cb);
  },
  
  // Settings window
  openSettingsWindow: () => ipcRenderer.invoke("quolldesk:settings:open"),
  closeSettingsWindow: () => ipcRenderer.invoke("quolldesk:settings:close"),

  // Cross-window settings sync
  notifySettingsChanged: (payload) => ipcRenderer.send("quolldesk:settings:changed", payload),
  onSettingsChanged: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("quolldesk:settings:changed", handler);
    return () => ipcRenderer.removeListener("quolldesk:settings:changed", handler);
  },
  getAppLockRuntimeState: () => ipcRenderer.invoke("quolldesk:appLock:getRuntimeState"),
  getAppLockSettings: () => ipcRenderer.invoke("quolldesk:appLock:getSettings"),
  setAppLockTimeoutMinutes: (timeoutMinutes) =>
    ipcRenderer.invoke("quolldesk:appLock:setTimeoutMinutes", timeoutMinutes),
  requestAppLockEnable: () => ipcRenderer.invoke("quolldesk:appLock:requestEnable"),
  requestAppLockDisable: (currentPassword) =>
    ipcRenderer.invoke("quolldesk:appLock:requestDisable", currentPassword),
  requestAppLockReset: (currentPassword) =>
    ipcRenderer.invoke("quolldesk:appLock:requestReset", currentPassword),
  requestAppLockPasswordChange: (input) =>
    ipcRenderer.invoke("quolldesk:appLock:requestPasswordChange", input),
  setAppLockRuntimeLocked: (reason) =>
    ipcRenderer.invoke("quolldesk:appLock:setLocked", reason),
  requestAppLockUnlock: (password) =>
    ipcRenderer.invoke("quolldesk:appLock:requestUnlock", password),
  getAppLockSystemUnlockStatus: () =>
    ipcRenderer.invoke("quolldesk:appLock:getSystemUnlockStatus"),
  setAppLockSystemUnlockEnabled: (input) =>
    ipcRenderer.invoke("quolldesk:appLock:setSystemUnlockEnabled", input),
  requestAppLockSystemUnlock: () =>
    ipcRenderer.invoke("quolldesk:appLock:requestSystemUnlock"),
  reportAppLockActivity: () =>
    ipcRenderer.invoke("quolldesk:appLock:reportActivity"),
  onAppLockSettingsChanged: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("quolldesk:appLock:settingsChanged", handler);
    return () => ipcRenderer.removeListener("quolldesk:appLock:settingsChanged", handler);
  },
  onAppLockRuntimeStateChanged: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("quolldesk:appLock:runtimeStateChanged", handler);
    return () => ipcRenderer.removeListener("quolldesk:appLock:runtimeStateChanged", handler);
  },
  getSshDebugLogInfo: () => ipcRenderer.invoke("quolldesk:sshDebugLog:info"),
  openSshDebugLogDir: () => ipcRenderer.invoke("quolldesk:sshDebugLog:openDir"),

  // Cloud sync session (in-memory only, shared across windows)
  cloudSyncSetSessionPassword: (password) =>
    ipcRenderer.invoke("quolldesk:cloudSync:session:setPassword", password),
  onCloudSyncSessionPasswordAvailable: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("quolldesk:cloudSync:session:passwordAvailable", handler);
    return () => ipcRenderer.removeListener("quolldesk:cloudSync:session:passwordAvailable", handler);
  },
  cloudSyncGetSessionPassword: () =>
    ipcRenderer.invoke("quolldesk:cloudSync:session:getPassword"),
  cloudSyncClearSessionPassword: () =>
    ipcRenderer.invoke("quolldesk:cloudSync:session:clearPassword"),

  // Cloud sync network operations (proxied via main process)
  cloudSyncWebdavInitialize: (config) =>
    ipcRenderer.invoke("quolldesk:cloudSync:webdav:initialize", { config }),
  cloudSyncWebdavUpload: (config, syncedFile) =>
    ipcRenderer.invoke("quolldesk:cloudSync:webdav:upload", { config, syncedFile }),
  cloudSyncWebdavDownload: (config) =>
    ipcRenderer.invoke("quolldesk:cloudSync:webdav:download", { config }),
  cloudSyncWebdavDelete: (config) =>
    ipcRenderer.invoke("quolldesk:cloudSync:webdav:delete", { config }),

  cloudSyncS3Initialize: (config) =>
    ipcRenderer.invoke("quolldesk:cloudSync:s3:initialize", { config }),
  cloudSyncS3Upload: (config, syncedFile) =>
    ipcRenderer.invoke("quolldesk:cloudSync:s3:upload", { config, syncedFile }),
  cloudSyncS3Download: (config) =>
    ipcRenderer.invoke("quolldesk:cloudSync:s3:download", { config }),
  cloudSyncS3Delete: (config) =>
    ipcRenderer.invoke("quolldesk:cloudSync:s3:delete", { config }),
  
  // Open URL in default browser
  openExternal: (url) => ipcRenderer.invoke("quolldesk:openExternal", url),
  focusHostBrowser: (hostId) => ipcRenderer.invoke("quolldesk:host-browser:focus", hostId),
  setHostBrowserPanelLayout: (options) => ipcRenderer.invoke("quolldesk:host-browser:panel-layout", options),
  closeHostBrowserPanel: (browserId) => ipcRenderer.invoke("quolldesk:host-browser:panel-close", browserId),
  getHostBrowserPanelState: (browserId) => ipcRenderer.invoke("quolldesk:host-browser:snapshot", browserId),
  commandHostBrowserPanel: (browserId, command) => ipcRenderer.invoke("quolldesk:host-browser:command", command, browserId),
  listHostBrowserPanelBookmarks: (browserId) => ipcRenderer.invoke("quolldesk:host-browser:bookmarks:list", browserId),
  saveHostBrowserPanelBookmark: (browserId, bookmark) => ipcRenderer.invoke("quolldesk:host-browser:bookmarks:upsert", bookmark, browserId),
  removeHostBrowserPanelBookmark: (browserId, id) => ipcRenderer.invoke("quolldesk:host-browser:bookmarks:remove", id, browserId),
  listHostBrowserPanelDownloads: (browserId) => ipcRenderer.invoke("quolldesk:host-browser:downloads:list", browserId),
  commandHostBrowserPanelDownload: (browserId, command) => ipcRenderer.invoke("quolldesk:host-browser:downloads:command", command, browserId),
  onHostBrowserPanelEvent: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("quolldesk:host-browser:panel-event", listener);
    return () => ipcRenderer.removeListener("quolldesk:host-browser:panel-event", listener);
  },
  openHostBrowserUrl: (options) => ipcRenderer.invoke("quolldesk:host-browser:panel-url", options),
  requestHostBrowserPanel: (request) => ipcRenderer.invoke("quolldesk:host-browser:request-panel", request),
  onHostBrowserPanelRequest: (callback) => {
    hostBrowserPanelListeners.add(callback);
    for (const request of pendingHostBrowserPanels.splice(0)) callback(request);
    return () => hostBrowserPanelListeners.delete(callback);
  },
  openHostBrowser: (options) => ipcRenderer.invoke("quolldesk:host-browser:open", options),
  getHostBrowserBookmarks: () => ipcRenderer.invoke("quolldesk:host-browser:bookmarks:get-all"),
  applyHostBrowserBookmarks: (items) => ipcRenderer.invoke("quolldesk:host-browser:bookmarks:apply", items),
  onHostBrowserBookmarksChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("quolldesk:host-browser:bookmarks-changed", listener);
    return () => ipcRenderer.removeListener("quolldesk:host-browser:bookmarks-changed", listener);
  },
  openPath: (path) => ipcRenderer.invoke("quolldesk:openPath", path),

  // App info
  getAppInfo: () => ipcRenderer.invoke("quolldesk:app:getInfo"),
  ptyGetChildProcesses: (sessionId) =>
    ipcRenderer.invoke("quolldesk:pty:childProcesses", sessionId),
  confirmCloseBusy: (payload) =>
    ipcRenderer.invoke("quolldesk:dialog:confirmCloseBusy", payload),
  getVaultBackupCapabilities: () =>
    ipcRenderer.invoke("quolldesk:vaultBackups:capabilities"),
  createVaultBackup: (payload) =>
    ipcRenderer.invoke("quolldesk:vaultBackups:create", payload),
  listVaultBackups: () =>
    ipcRenderer.invoke("quolldesk:vaultBackups:list"),
  readVaultBackup: (payload) =>
    ipcRenderer.invoke("quolldesk:vaultBackups:read", payload),
  trimVaultBackups: (payload) =>
    ipcRenderer.invoke("quolldesk:vaultBackups:trim", payload),
  clearVaultBackups: () =>
    ipcRenderer.invoke("quolldesk:vaultBackups:clear"),
  openVaultBackupDir: () =>
    ipcRenderer.invoke("quolldesk:vaultBackups:openDir"),
  // Subscribe to cross-window "backups changed" events emitted by the
  // main process whenever a create/trim actually mutated the on-disk
  // set. Returns an unsubscribe function so React-style consumers can
  // release the listener on unmount without leaking IPC handlers.
  onVaultBackupsChanged: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = () => {
      try { handler(); } catch (error) {
        console.warn("[preload] onVaultBackupsChanged handler threw:", error);
      }
    };
    ipcRenderer.on("quolldesk:vaultBackups:changed", listener);
    return () => {
      try { ipcRenderer.removeListener("quolldesk:vaultBackups:changed", listener); }
      catch { /* ignore */ }
    };
  },

  // Tell main process the renderer has mounted/painted (used to avoid initial blank screen).
  rendererReady: () => ipcRenderer.send("quolldesk:renderer:ready"),

  onSshDeepLink: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("quolldesk:deepLink:ssh", handler);
    return () => ipcRenderer.removeListener("quolldesk:deepLink:ssh", handler);
  },
  onTelnetDeepLink: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("quolldesk:deepLink:telnet", handler);
    return () => ipcRenderer.removeListener("quolldesk:deepLink:telnet", handler);
  },
  onOpenTerminalPath: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("quolldesk:openTerminalPath", handler);
    return () => ipcRenderer.removeListener("quolldesk:openTerminalPath", handler);
  },
  onColdStartIntentsSettled: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("quolldesk:startup:coldStartIntentsSettled", handler);
    return () => ipcRenderer.removeListener("quolldesk:startup:coldStartIntentsSettled", handler);
  },
  setSshDeepLinkEnabled: (enabled) =>
    ipcRenderer.invoke("quolldesk:deepLink:ssh:setEnabled", { enabled }),
  getSshDeepLinkEnabled: () =>
    ipcRenderer.invoke("quolldesk:deepLink:ssh:getEnabled"),

  onJmsDeepLink: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("quolldesk:deepLink:jms", handler);
    return () => ipcRenderer.removeListener("quolldesk:deepLink:jms", handler);
  },
  setJmsDeepLinkEnabled: (enabled) =>
    ipcRenderer.invoke("quolldesk:deepLink:jms:setEnabled", { enabled }),
  getJmsDeepLinkEnabled: () =>
    ipcRenderer.invoke("quolldesk:deepLink:jms:getEnabled"),

  setExplorerContextMenuEnabled: (enabled) =>
    ipcRenderer.invoke("quolldesk:explorerContextMenu:setEnabled", { enabled }),
  getExplorerContextMenuEnabled: () =>
    ipcRenderer.invoke("quolldesk:explorerContextMenu:getEnabled"),

  // Quit guard: main process asks whether any editor tabs have unsaved changes.
  // Returns an unsubscribe function so React effects can clean up on unmount.
  onCheckDirtyEditors: (listener) => {
    const handler = (_event, request) => listener(request);
    ipcRenderer.on("app:query-dirty-editors", handler);
    return () => ipcRenderer.removeListener("app:query-dirty-editors", handler);
  },
  // Renderer reports the dirty-check result back to the main process.
  reportDirtyEditorsResult: (hasDirty, reason, options) => ipcRenderer.send("app:dirty-editors-result", {
    hasDirty, reason, requestId: options?.requestId, pending: options?.pending === true,
  }),
  onFinalizeSessionLogs: (finalize) => {
    sessionLogFinalizers.add(finalize);
    return () => sessionLogFinalizers.delete(finalize);
  },
  
  // Port Forwarding API
  startPortForward: async (options) => {
    return ipcRenderer.invoke("quolldesk:portforward:start", options);
  },
  stopPortForward: async (tunnelId) => {
    return ipcRenderer.invoke("quolldesk:portforward:stop", { tunnelId });
  },
  getPortForwardStatus: async (tunnelId) => {
    return ipcRenderer.invoke("quolldesk:portforward:status", { tunnelId });
  },
  subscribePortForward: async (tunnelId) => {
    return ipcRenderer.invoke("quolldesk:portforward:subscribe", { tunnelId });
  },
  listPortForwards: async () => {
    return ipcRenderer.invoke("quolldesk:portforward:list");
  },
  getPortForwardSnapshot: async () => {
    return ipcRenderer.invoke("quolldesk:portforward:snapshot");
  },
  subscribePortForwardRuntime: async () => {
    return ipcRenderer.invoke("quolldesk:portforward:subscribeRuntime");
  },
  unsubscribePortForwardRuntime: async () => {
    return ipcRenderer.invoke("quolldesk:portforward:unsubscribeRuntime");
  },
  stopAllPortForwards: async () => {
    return ipcRenderer.invoke("quolldesk:portforward:stopAll");
  },
  stopPortForwardByRuleId: async (ruleId) => {
    return ipcRenderer.invoke("quolldesk:portforward:stopByRuleId", { ruleId });
  },
  onPortForwardStatus: (tunnelId, cb) => {
    if (!portForwardStatusListeners.has(tunnelId)) {
      portForwardStatusListeners.set(tunnelId, new Set());
    }
    portForwardStatusListeners.get(tunnelId).add(cb);
    return () => {
      portForwardStatusListeners.get(tunnelId)?.delete(cb);
      if (portForwardStatusListeners.get(tunnelId)?.size === 0) {
        portForwardStatusListeners.delete(tunnelId);
      }
    };
  },
  onPortForwardRuntime: (cb) => {
    portForwardRuntimeListeners.add(cb);
    return () => {
      portForwardRuntimeListeners.delete(cb);
    };
  },
  // Chain progress listener for jump host connections
  onChainProgress: (cb) => {
    const id = randomUUID();
    chainProgressListeners.set(id, cb);
    return () => {
      chainProgressListeners.delete(id);
    };
  },
  onConnectionReuseFallback: (cb) => {
    connectionReuseFallbackListeners.add(cb);
    return () => {
      connectionReuseFallbackListeners.delete(cb);
    };
  },
  // SFTP connection progress listener (auth method logs)
  onSftpConnectionProgress: (cb) => {
    sftpConnectionProgressListeners.add(cb);
    return () => {
      sftpConnectionProgressListeners.delete(cb);
    };
  },

  // OAuth callback server — two-step so the renderer can learn the bound
  // port (which may differ from the preferred 45678 if it was in use) and
  // embed it into the provider's redirect_uri before opening the browser.
  prepareOAuthCallback: () => ipcRenderer.invoke("oauth:prepareCallback"),
  awaitOAuthCallback: (expectedState, sessionId) =>
    ipcRenderer.invoke("oauth:awaitCallback", expectedState, sessionId),
  cancelOAuthCallback: (sessionId) => ipcRenderer.invoke("oauth:cancelCallback", sessionId),

  // GitHub Device Flow (proxied via main process to avoid CORS)
  githubStartDeviceFlow: (options) => ipcRenderer.invoke("quolldesk:github:deviceFlow:start", options),
  githubPollDeviceFlowToken: (options) => ipcRenderer.invoke("quolldesk:github:deviceFlow:poll", options),
  githubCancelDeviceFlowPoll: (pollId) => ipcRenderer.invoke("quolldesk:github:deviceFlow:cancelPoll", pollId),
  githubDownloadGistRawContent: (options) => ipcRenderer.invoke("quolldesk:github:gistRawContent", options),

  // Google OAuth (proxied via main process to avoid CORS)
  googleExchangeCodeForTokens: (options) =>
    ipcRenderer.invoke("quolldesk:google:oauth:exchange", options),
  googleRefreshAccessToken: (options) =>
    ipcRenderer.invoke("quolldesk:google:oauth:refresh", options),
  googleGetUserInfo: (options) =>
    ipcRenderer.invoke("quolldesk:google:oauth:userinfo", options),

  // Google Drive API (proxied via main process to avoid CORS/COEP issues in renderer)
  googleDriveFindSyncFile: (options) =>
    ipcRenderer.invoke("quolldesk:google:drive:findSyncFile", options),
  googleDriveCreateSyncFile: (options) =>
    ipcRenderer.invoke("quolldesk:google:drive:createSyncFile", options),
  googleDriveUpdateSyncFile: (options) =>
    ipcRenderer.invoke("quolldesk:google:drive:updateSyncFile", options),
  googleDriveDownloadSyncFile: (options) =>
    ipcRenderer.invoke("quolldesk:google:drive:downloadSyncFile", options),
  googleDriveDeleteSyncFile: (options) =>
    ipcRenderer.invoke("quolldesk:google:drive:deleteSyncFile", options),

  // OneDrive OAuth + Graph (proxied via main process to avoid CORS)
  onedriveExchangeCodeForTokens: (options) =>
    ipcRenderer.invoke("quolldesk:onedrive:oauth:exchange", options),
  onedriveRefreshAccessToken: (options) =>
    ipcRenderer.invoke("quolldesk:onedrive:oauth:refresh", options),
  onedriveGetUserInfo: (options) =>
    ipcRenderer.invoke("quolldesk:onedrive:oauth:userinfo", options),
  onedriveFindSyncFile: (options) =>
    ipcRenderer.invoke("quolldesk:onedrive:drive:findSyncFile", options),
  onedriveUploadSyncFile: (options) =>
    ipcRenderer.invoke("quolldesk:onedrive:drive:uploadSyncFile", options),
  onedriveDownloadSyncFile: (options) =>
    ipcRenderer.invoke("quolldesk:onedrive:drive:downloadSyncFile", options),
  onedriveDeleteSyncFile: (options) =>
    ipcRenderer.invoke("quolldesk:onedrive:drive:deleteSyncFile", options),

  // File opener helpers (for "Open With" feature)
  selectApplication: () =>
    ipcRenderer.invoke("quolldesk:selectApplication"),
  openWithApplication: (filePath, appPath) =>
    ipcRenderer.invoke("quolldesk:openWithApplication", { filePath, appPath }),
  openWithSystemDefault: (filePath) =>
    ipcRenderer.invoke("quolldesk:openWithSystemDefault", { filePath }),
  downloadSftpToTempWithProgress: (sftpId, remotePath, fileName, encoding, transferId) =>
    ipcRenderer.invoke("quolldesk:sftp:downloadToTempWithProgress", {
      sftpId,
      remotePath,
      fileName,
      encoding,
      transferId,
    }),

  // Save dialog for file downloads
  showSaveDialog: (defaultPath, filters) =>
    ipcRenderer.invoke("quolldesk:showSaveDialog", { defaultPath, filters }),
  selectDirectory: (title, defaultPath) =>
    ipcRenderer.invoke("quolldesk:selectDirectory", { title, defaultPath }),
  selectFile: (title, defaultPath, filters) =>
    ipcRenderer.invoke("quolldesk:selectFile", { title, defaultPath, filters }),

  // File watcher for auto-sync feature
  startFileWatch: (localPath, remotePath, sftpId, encoding) =>
    ipcRenderer.invoke("quolldesk:filewatch:start", { localPath, remotePath, sftpId, encoding }),
  stopFileWatch: (watchId, cleanupTempFile = false) =>
    ipcRenderer.invoke("quolldesk:filewatch:stop", { watchId, cleanupTempFile }),
  listFileWatches: () =>
    ipcRenderer.invoke("quolldesk:filewatch:list"),
  registerTempFile: (sftpId, localPath) =>
    ipcRenderer.invoke("quolldesk:filewatch:registerTempFile", { sftpId, localPath }),
  unregisterTempFile: (sftpId, localPath) =>
    ipcRenderer.invoke("quolldesk:filewatch:unregisterTempFile", { sftpId, localPath }),
  onFileWatchSynced: (cb) => {
    fileWatchSyncedListeners.add(cb);
    return () => fileWatchSyncedListeners.delete(cb);
  },
  onFileWatchError: (cb) => {
    fileWatchErrorListeners.add(cb);
    return () => fileWatchErrorListeners.delete(cb);
  },
  onFileWatchStopped: (cb) => {
    fileWatchStoppedListeners.add(cb);
    return () => fileWatchStoppedListeners.delete(cb);
  },
  
  // Temp file cleanup
  deleteTempFile: (filePath) =>
    ipcRenderer.invoke("quolldesk:deleteTempFile", { filePath }),
  
  // Temp directory management
  getTempDirInfo: () =>
    ipcRenderer.invoke("quolldesk:tempdir:getInfo"),
  chooseTempDir: () => ipcRenderer.invoke("quolldesk:tempdir:choose"),
  setCustomTempDir: (dir) => ipcRenderer.invoke("quolldesk:tempdir:setCustom", dir),
  resetCustomTempDir: () => ipcRenderer.invoke("quolldesk:tempdir:resetCustom"),
  clearTempDir: () =>
    ipcRenderer.invoke("quolldesk:tempdir:clear"),
  getTempDirPath: () =>
    ipcRenderer.invoke("quolldesk:tempdir:getPath"),
  openTempDir: () =>
    ipcRenderer.invoke("quolldesk:tempdir:open"),
  getToolOutputPersistenceStatus: () =>
    ipcRenderer.invoke("quolldesk:tempdir:toolOutputPersistenceStatus"),
  writeToolOutputTemp: (record, content) =>
    ipcRenderer.invoke("quolldesk:tempdir:toolOutputWrite", { record, content }),
  restoreToolOutputTemp: (handleId, chatSessionId) =>
    ipcRenderer.invoke("quolldesk:tempdir:toolOutputRestore", { handleId, chatSessionId }),
  readToolOutputTemp: (filePath, request) =>
    ipcRenderer.invoke("quolldesk:tempdir:toolOutputRead", { path: filePath, request }),
  deleteToolOutputTemp: (filePath) =>
    ipcRenderer.invoke("quolldesk:tempdir:toolOutputDelete", { path: filePath }),
  deleteChatToolOutputsTemp: (chatSessionId) =>
    ipcRenderer.invoke("quolldesk:tempdir:toolOutputDeleteSession", { chatSessionId }),
  deleteTerminalToolOutputsTemp: (chatSessionId, terminalSessionId) =>
    ipcRenderer.invoke("quolldesk:tempdir:toolOutputDeleteTerminalSession", { chatSessionId, terminalSessionId }),
  deleteTerminalToolOutputsEverywhereTemp: (terminalSessionId) =>
    ipcRenderer.invoke("quolldesk:tempdir:toolOutputDeleteTerminal", { terminalSessionId }),

  // Session Logs
  exportSessionLog: (payload) =>
    ipcRenderer.invoke("quolldesk:sessionLogs:export", payload),
  selectSessionLogsDir: () =>
    ipcRenderer.invoke("quolldesk:sessionLogs:selectDir"),
  autoSaveSessionLog: (payload) =>
    ipcRenderer.invoke("quolldesk:sessionLogs:autoSave", payload),
  openSessionLogsDir: (directory) =>
    ipcRenderer.invoke("quolldesk:sessionLogs:openDir", { directory }),
  clearSessionLogsDir: (directory) =>
    ipcRenderer.invoke("quolldesk:sessionLogs:clear", { directory }),
  chooseManualSessionLogPath: (payload) =>
    ipcRenderer.invoke("quolldesk:sessionLog:manualChoosePath", payload),
  startManualSessionLog: (payload) =>
    ipcRenderer.invoke("quolldesk:sessionLog:manualStart", payload),
  stopManualSessionLog: (payload) =>
    ipcRenderer.invoke("quolldesk:sessionLog:manualStop", payload),
  prepareSessionLog: (payload) =>
    ipcRenderer.invoke("quolldesk:sessionLog:prepare", { sessionId: payload.sessionId }),
  revealSessionLog: (payload) =>
    ipcRenderer.invoke("quolldesk:sessionLog:reveal", { sessionId: payload.sessionId }),
  getManualSessionLogStatus: (payload) =>
    ipcRenderer.invoke("quolldesk:sessionLog:manualStatus", payload),

  // Crash Logs
  getCrashLogs: () =>
    ipcRenderer.invoke("quolldesk:crashLogs:list"),
  readCrashLog: (fileName) =>
    ipcRenderer.invoke("quolldesk:crashLogs:read", { fileName }),
  clearCrashLogs: () =>
    ipcRenderer.invoke("quolldesk:crashLogs:clear"),
  openCrashLogsDir: () =>
    ipcRenderer.invoke("quolldesk:crashLogs:openDir"),

  // AI Sessions Backup (disk mirror of the AI chat session store)
  aiSessionsBackupWrite: (payload) =>
    ipcRenderer.invoke("quolldesk:aiSessionsBackup:write", payload),
  aiSessionsBackupReadLatest: () =>
    ipcRenderer.invoke("quolldesk:aiSessionsBackup:readLatest"),
  aiSessionsBackupExport: (payload) =>
    ipcRenderer.invoke("quolldesk:aiSessionsBackup:export", payload),
  aiSessionsBackupImport: () =>
    ipcRenderer.invoke("quolldesk:aiSessionsBackup:import"),

  // Global Toggle Hotkey (Quake Mode)
  registerGlobalHotkey: (hotkey) =>
    ipcRenderer.invoke("quolldesk:globalHotkey:register", { hotkey }),
  unregisterGlobalHotkey: () =>
    ipcRenderer.invoke("quolldesk:globalHotkey:unregister"),
  getGlobalHotkeyStatus: () =>
    ipcRenderer.invoke("quolldesk:globalHotkey:status"),

  // System Tray / Close to Tray
  setCloseToTray: (enabled) =>
    ipcRenderer.invoke("quolldesk:tray:setCloseToTray", { enabled }),
  isCloseToTray: () =>
    ipcRenderer.invoke("quolldesk:tray:isCloseToTray"),
  setShowTrayIcon: (enabled) =>
    ipcRenderer.invoke("quolldesk:tray:setShowTrayIcon", { enabled }),
  isShowTrayIcon: () =>
    ipcRenderer.invoke("quolldesk:tray:isShowTrayIcon"),

  // Auto Launch at system login (hidden to tray)
  getAutoLaunch: () =>
    ipcRenderer.invoke("quolldesk:autoLaunch:get"),
  setAutoLaunch: (enabled) =>
    ipcRenderer.invoke("quolldesk:autoLaunch:set", { enabled }),

  // App-level HTTP(S) network proxy (cloud sync / AI providers)
  setHttpNetworkProxy: (settings) =>
    ipcRenderer.invoke("quolldesk:networkProxy:set", settings),
  getHttpNetworkProxy: () =>
    ipcRenderer.invoke("quolldesk:networkProxy:get"),
  updateTrayMenuData: (data) =>
    ipcRenderer.invoke("quolldesk:tray:updateMenuData", data),
  onAppLockReopen: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("quolldesk:app-lock:reopen", handler);
    return () => ipcRenderer.removeListener("quolldesk:app-lock:reopen", handler);
  },
  // Listen for tray menu actions
  onTrayFocusSession: (callback) => {
    const handler = (_event, sessionId) => callback(sessionId);
    ipcRenderer.on("quolldesk:tray:focusSession", handler);
    return () => ipcRenderer.removeListener("quolldesk:tray:focusSession", handler);
  },
  onTrayTogglePortForward: (callback) => {
    const handler = (_event, ruleId, start) => callback(ruleId, start);
    const startHandler = (_event, ruleId) => callback(ruleId, true);
    ipcRenderer.on("quolldesk:tray:togglePortForward", handler);
    ipcRenderer.on("quolldesk:trayPanel:startPortForward", startHandler);
    return () => {
      ipcRenderer.removeListener("quolldesk:tray:togglePortForward", handler);
      ipcRenderer.removeListener("quolldesk:trayPanel:startPortForward", startHandler);
    };
  },

  // Tray panel actions forwarded to main window
  onTrayPanelJumpToSession: (callback) => {
    const handler = (_event, sessionId) => callback(sessionId);
    ipcRenderer.on("quolldesk:trayPanel:jumpToSession", handler);
    return () => ipcRenderer.removeListener("quolldesk:trayPanel:jumpToSession", handler);
  },
  onTrayPanelConnectToHost: (callback) => {
    const handler = (_event, hostId) => callback(hostId);
    ipcRenderer.on("quolldesk:trayPanel:connectToHost", handler);
    return () => ipcRenderer.removeListener("quolldesk:trayPanel:connectToHost", handler);
  },
  onTrayPanelCloseSession: (callback) => {
    const handler = (_event, sessionId) => callback(sessionId);
    ipcRenderer.on("quolldesk:trayPanel:closeSession", handler);
    return () => ipcRenderer.removeListener("quolldesk:trayPanel:closeSession", handler);
  },

  // Tray panel window
  hideTrayPanel: () => ipcRenderer.invoke("quolldesk:trayPanel:hide"),
  openMainWindow: () => ipcRenderer.invoke("quolldesk:trayPanel:openMainWindow"),
  quitApp: () => ipcRenderer.invoke("quolldesk:trayPanel:quitApp"),
  jumpToSessionFromTrayPanel: (sessionId) =>
    ipcRenderer.invoke("quolldesk:trayPanel:jumpToSession", sessionId),
  connectToHostFromTrayPanel: (hostId) =>
    ipcRenderer.invoke("quolldesk:trayPanel:connectToHost", hostId),
  startPortForwardFromTrayPanel: (ruleId) =>
    ipcRenderer.invoke("quolldesk:trayPanel:startPortForward", ruleId),
  closeSessionFromTrayPanel: (sessionId) =>
    ipcRenderer.invoke("quolldesk:trayPanel:closeSession", sessionId),
  onTrayPanelCloseRequest: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("quolldesk:trayPanel:closeRequest", handler);
    return () => ipcRenderer.removeListener("quolldesk:trayPanel:closeRequest", handler);
  },

  onTrayPanelRefresh: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("quolldesk:trayPanel:refresh", handler);
    return () => ipcRenderer.removeListener("quolldesk:trayPanel:refresh", handler);
  },

  onTrayPanelMenuData: (callback) => {
    // Replay buffered data so late subscribers (e.g. after React lazy-mount) don't miss
    // the initial payload that was sent before the useEffect listener was registered.
    if (_lastTrayMenuData) {
      queueMicrotask(() => callback(_lastTrayMenuData));
    }
    const handler = (_event, data) => {
      _lastTrayMenuData = data;
      callback(data);
    };
    ipcRenderer.on("quolldesk:trayPanel:setMenuData", handler);
    return () => ipcRenderer.removeListener("quolldesk:trayPanel:setMenuData", handler);
  },

  // Get file path from File object (for drag-and-drop)
  startLocalFileDrag: (payload) => ipcRenderer.invoke("quolldesk:local:drag-start", payload),
  cancelLocalFileDrag: (requestId) => ipcRenderer.send("quolldesk:local:drag-cancel", { requestId }),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return undefined;
    }
  },
  stageUploadFile: async (file, transferId) => {
    uploadStageControllers.get(transferId)?.abort(new Error("Upload staging superseded"));
    const controller = new AbortController();
    uploadStageControllers.set(transferId, controller);
    let localPath = null;
    try {
      localPath = await ipcRenderer.invoke("quolldesk:tempdir:createUploadPath", {
        transferId: `${transferId}-${randomUUID()}`,
        fileName: file?.name || "upload.bin",
      });
      return await stageRendererFileToTemp(file, localPath, fs, controller.signal);
    } catch (error) {
      if (localPath) {
        await ipcRenderer.invoke("quolldesk:deleteTempFile", { filePath: localPath }).catch(() => {});
      }
      throw error;
    } finally {
      if (uploadStageControllers.get(transferId) === controller) {
        uploadStageControllers.delete(transferId);
      }
    }
  },
  cancelStagedUploadFile: async (transferId) => {
    const controller = uploadStageControllers.get(transferId);
    if (!controller) return { success: false };
    controller.abort(new Error("Upload staging cancelled"));
    return { success: true };
  },

  showSystemNotification: async (payload) => {
    return ipcRenderer.invoke("quolldesk:notification:show", payload ?? {});
  },
  setExternalMcpApprovalAlertMode: async (payload) => {
    return ipcRenderer.invoke("quolldesk:mcp:approval-alert-mode", payload ?? {});
  },

  // Clipboard fallback helpers
  readClipboardText: async () => {
    return ipcRenderer.invoke("quolldesk:clipboard:readText");
  },
  writeClipboardText: async (text) => {
    return ipcRenderer.invoke("quolldesk:clipboard:writeText", text);
  },
  readClipboardFiles: async () => {
    return ipcRenderer.invoke("quolldesk:clipboard:readFiles");
  },
  readClipboardImage: async () => {
    return ipcRenderer.invoke("quolldesk:clipboard:readImage");
  },
  hasClipboardImage: async () => {
    return ipcRenderer.invoke("quolldesk:clipboard:hasImage");
  },

  // Credential encryption (field-level safeStorage)
  credentialsAvailable: () => ipcRenderer.invoke("quolldesk:credentials:available"),
  credentialsEncrypt: (plaintext) => ipcRenderer.invoke("quolldesk:credentials:encrypt", plaintext),
  credentialsDecrypt: (value) => ipcRenderer.invoke("quolldesk:credentials:decrypt", value),
  previewTotp: (payload) => ipcRenderer.invoke("quolldesk:totp:preview", payload),
  scanTotpQrFromScreen: () => ipcRenderer.invoke("quolldesk:totp:scan-screen"),

  // Auto-update
  checkForUpdate: () => ipcRenderer.invoke("quolldesk:update:check"),
  downloadUpdate: () => ipcRenderer.invoke("quolldesk:update:download"),
  installUpdate: () => ipcRenderer.invoke("quolldesk:update:install"),
  getUpdateStatus: () => ipcRenderer.invoke("quolldesk:update:getStatus"),
  setAutoUpdate: (enabled) => ipcRenderer.invoke("quolldesk:update:setAutoUpdate", { enabled }),
  getAutoUpdate: () => ipcRenderer.invoke("quolldesk:update:getAutoUpdate"),
  onUpdateAvailable: (cb) => {
    updateAvailableListeners.add(cb);
    return () => updateAvailableListeners.delete(cb);
  },
  onUpdateNotAvailable: (cb) => {
    updateNotAvailableListeners.add(cb);
    return () => updateNotAvailableListeners.delete(cb);
  },
  onUpdateDownloadProgress: (cb) => {
    updateDownloadProgressListeners.add(cb);
    return () => updateDownloadProgressListeners.delete(cb);
  },
  onUpdateDownloaded: (cb) => {
    updateDownloadedListeners.add(cb);
    return () => updateDownloadedListeners.delete(cb);
  },
  onUpdateError: (cb) => {
    updateErrorListeners.add(cb);
    return () => updateErrorListeners.delete(cb);
  },
  onUpdateNeedsSave: (cb) => {
    updateNeedsSaveListeners.add(cb);
    return () => updateNeedsSaveListeners.delete(cb);
  },

  // ── AI Bridge ──
  aiSyncProviders: async (providers) => {
    return ipcRenderer.invoke("quolldesk:ai:sync-providers", { providers });
  },
  aiSyncWebSearch: async (apiHost, apiKey) => {
    return ipcRenderer.invoke("quolldesk:ai:sync-web-search", { apiHost, apiKey });
  },
  aiChatStream: async (requestId, url, headers, body, providerId, idleTimeoutMs) => {
    return ipcRenderer.invoke("quolldesk:ai:chat:stream", {
      requestId,
      url,
      headers,
      body,
      providerId,
      idleTimeoutMs,
    });
  },
  aiChatCancel: async (requestId) => {
    return ipcRenderer.invoke("quolldesk:ai:chat:cancel", { requestId });
  },
  aiFetch: async (url, method, headers, body, providerId, skipHostCheck, followRedirects, skipTLSVerify, requestId) => {
    return ipcRenderer.invoke("quolldesk:ai:fetch", { url, method, headers, body, providerId, skipHostCheck, followRedirects, skipTLSVerify, ...(requestId ? { requestId } : {}) });
  },
  aiAllowlistAddHost: async (baseURL) => {
    return ipcRenderer.invoke("quolldesk:ai:allowlist:add-host", { baseURL });
  },
  aiExec: async (sessionId, command, chatSessionId, delegationTag) => {
    return ipcRenderer.invoke("quolldesk:ai:exec", { sessionId, command, chatSessionId, ...(delegationTag ? { delegationTag } : {}) });
  },
  aiQuollCancelExec: async (chatSessionId, delegationTag) => {
    return ipcRenderer.invoke("quolldesk:ai:quoll:cancel", { chatSessionId, ...(delegationTag ? { delegationTag } : {}) });
  },
  aiSetChatSessionCancelled: async (chatSessionId, cancelled = true, delegationTag) => {
    return ipcRenderer.invoke("quolldesk:ai:chat-session:set-cancelled", { chatSessionId, cancelled, ...(delegationTag ? { delegationTag } : {}) });
  },
  aiCapability: async (rpcMethod, params, chatSessionId, delegationTag) => {
    return ipcRenderer.invoke("quolldesk:ai:capability", { rpcMethod, params, chatSessionId, ...(delegationTag ? { delegationTag } : {}) });
  },
  aiDiscoverAgents: async (options) => {
    return ipcRenderer.invoke("quolldesk:ai:agents:discover", options);
  },
  aiPrewarmShellEnv: async () => {
    return ipcRenderer.invoke("quolldesk:ai:shell-env:prewarm");
  },
  aiResolveCli: async (params) => {
    return ipcRenderer.invoke("quolldesk:ai:resolve-cli", params);
  },
  aiCodexGetIntegration: async (options) => {
    return ipcRenderer.invoke("quolldesk:ai:codex:get-integration", options);
  },
  aiCodexStartLogin: async (options) => {
    return ipcRenderer.invoke("quolldesk:ai:codex:start-login", options);
  },
  aiCodexGetLoginSession: async (sessionId) => {
    return ipcRenderer.invoke("quolldesk:ai:codex:get-login-session", { sessionId });
  },
  aiCodexCancelLogin: async (sessionId) => {
    return ipcRenderer.invoke("quolldesk:ai:codex:cancel-login", { sessionId });
  },
  aiCodexLogout: async (options) => {
    return ipcRenderer.invoke("quolldesk:ai:codex:logout", options);
  },
  // External MCP (productized catalog MCP for Codex / Claude Code / Cursor / Grok)
  externalMcpGetStatus: async () => {
    return ipcRenderer.invoke("quolldesk:external-mcp:get-status");
  },
  externalMcpSetEnabled: async (enabled) => {
    return ipcRenderer.invoke("quolldesk:external-mcp:set-enabled", { enabled });
  },
  externalMcpSetConfig: async (config) => {
    return ipcRenderer.invoke("quolldesk:external-mcp:set-config", config || {});
  },
  externalMcpGetUniversalSetupPrompt: async () => {
    return ipcRenderer.invoke("quolldesk:external-mcp:get-universal-setup-prompt");
  },
  externalMcpCodexGetStatus: async () => {
    return ipcRenderer.invoke("quolldesk:external-mcp:codex:get-status");
  },
  externalMcpCodexAdd: async () => {
    return ipcRenderer.invoke("quolldesk:external-mcp:codex:add");
  },
  externalMcpClaudeGetStatus: async () => {
    return ipcRenderer.invoke("quolldesk:external-mcp:claude:get-status");
  },
  externalMcpClaudeAdd: async () => {
    return ipcRenderer.invoke("quolldesk:external-mcp:claude:add");
  },
  externalMcpGrokGetStatus: async () => {
    return ipcRenderer.invoke("quolldesk:external-mcp:grok:get-status");
  },
  externalMcpGrokAdd: async () => {
    return ipcRenderer.invoke("quolldesk:external-mcp:grok:add");
  },
  // MCP Server session metadata
  aiPrivacyStatus: async () => ipcRenderer.invoke("quolldesk:ai:privacy:status"),
  aiPrivacyTransform: async (request) => ipcRenderer.invoke("quolldesk:ai:privacy:transform", request),
  aiPrivacyClearSession: async (chatSessionId) => ipcRenderer.invoke("quolldesk:ai:privacy:clear", chatSessionId),
  aiMcpUpdateSessions: async (sessions, chatSessionId, delegationTag) => {
    return ipcRenderer.invoke("quolldesk:ai:mcp:update-sessions", { sessions, chatSessionId, ...(delegationTag ? { delegationTag } : {}) });
  },
  aiMcpUpdateLiveSessions: async (sessions) => {
    return ipcRenderer.invoke("quolldesk:ai:mcp:update-live-sessions", { sessions });
  },
  aiMcpUpdateDbConnections: async (connections, chatSessionId) => {
    return ipcRenderer.invoke("quolldesk:ai:mcp:update-db-connections", { connections, chatSessionId });
  },
  setAiDatabaseAccessEnabled: async (enabled) => {
    return ipcRenderer.invoke("quolldesk:ai:mcp:set-db-access-enabled", { enabled });
  },
  aiMcpMergeSessions: async (sessions, chatSessionId) => {
    return ipcRenderer.invoke("quolldesk:ai:mcp:merge-sessions", { sessions, chatSessionId });
  },
  aiMcpUpdateAttachments: async (attachments, chatSessionId) => {
    return ipcRenderer.invoke("quolldesk:ai:mcp:update-attachments", { attachments, chatSessionId });
  },
  aiMcpSetCommandBlocklist: async (blocklist) => {
    return ipcRenderer.invoke("quolldesk:ai:mcp:set-command-blocklist", { blocklist });
  },
  aiMcpSetCommandTimeout: async (timeout) => {
    return ipcRenderer.invoke("quolldesk:ai:mcp:set-command-timeout", { timeout });
  },
  aiMcpSetMaxIterations: async (maxIterations) => {
    return ipcRenderer.invoke("quolldesk:ai:mcp:set-max-iterations", { maxIterations });
  },
  aiMcpSetPermissionMode: async (mode) => {
    return ipcRenderer.invoke("quolldesk:ai:mcp:set-permission-mode", { mode });
  },
  aiMcpSetToolIntegrationMode: async (mode) => {
    return ipcRenderer.invoke("quolldesk:ai:mcp:set-tool-integration-mode", { mode });
  },
  aiMcpSyncPermissionGrants: async (grants) => {
    return ipcRenderer.invoke("quolldesk:ai:mcp:sync-permission-grants", { grants });
  },
  aiUserSkillsGetStatus: async () => {
    return ipcRenderer.invoke("quolldesk:ai:user-skills:status");
  },
  aiUserSkillsOpenFolder: async () => {
    return ipcRenderer.invoke("quolldesk:ai:user-skills:open");
  },
  aiUserSkillsBuildContext: async (prompt, selectedSkillSlugs) => {
    return ipcRenderer.invoke("quolldesk:ai:user-skills:build-context", { prompt, selectedSkillSlugs });
  },
  aiSkillsCliGetInvocation: async () => {
    return ipcRenderer.invoke("quolldesk:ai:skills-cli:invocation");
  },
  // MCP approval gate: renderer receives approval requests from main process
  onMcpApprovalRequest: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("quolldesk:ai:mcp:approval-request", handler);
    return () => ipcRenderer.removeListener("quolldesk:ai:mcp:approval-request", handler);
  },
  respondMcpApproval: async (approvalId, approved, scope) => {
    return ipcRenderer.invoke("quolldesk:ai:mcp:approval-response", { approvalId, approved, scope });
  },
  cancelMcpApprovalTimeout: async (approvalId) => {
    return ipcRenderer.invoke("quolldesk:ai:mcp:approval-cancel-timeout", { approvalId });
  },
  // MCP approval cleared: main process timed out or cancelled an approval
  onMcpApprovalCleared: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("quolldesk:ai:mcp:approval-cleared", handler);
    return () => ipcRenderer.removeListener("quolldesk:ai:mcp:approval-cleared", handler);
  },
  onVaultAgentRequest: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("quolldesk:ai:vault-agent:request", handler);
    return () => ipcRenderer.removeListener("quolldesk:ai:vault-agent:request", handler);
  },
  respondVaultAgent: async (requestId, result) => {
    return ipcRenderer.invoke("quolldesk:ai:vault-agent:response", { requestId, result });
  },
  // SDK external agent streaming
  aiSdkAgentStream: async (requestId, chatSessionId, sdkBackend, prompt, cwd, providerId, model, existingSessionId, historyMessages, images, toolIntegrationMode, defaultTargetSession, userSkillsContext, agentEnv, agentCommand, codexRuntime, permissionMode, codebuddyOptions) => {
    const advanced = codebuddyOptions && typeof codebuddyOptions === "object"
      ? {
          effort: codebuddyOptions.effort,
          maxTurns: codebuddyOptions.maxTurns,
          maxBudgetUsd: codebuddyOptions.maxBudgetUsd,
          fallbackModel: codebuddyOptions.fallbackModel,
          sandbox: codebuddyOptions.sandbox,
          enableFileCheckpointing: codebuddyOptions.enableFileCheckpointing,
          persistSession: codebuddyOptions.persistSession,
        }
      : {};
    return ipcRenderer.invoke("quolldesk:ai:sdk-agent:stream", {
      requestId,
      chatSessionId,
      sdkBackend,
      prompt,
      cwd,
      providerId,
      model,
      existingSessionId,
      historyMessages,
      images,
      toolIntegrationMode,
      defaultTargetSession,
      userSkillsContext,
      agentEnv,
      agentCommand,
      codexRuntime,
      permissionMode,
      ...advanced,
    });
  },
  aiSdkAgentSteer: async (requestId, chatSessionId, prompt, images, clientUserMessageId) => {
    return ipcRenderer.invoke("quolldesk:ai:sdk-agent:steer", {
      requestId,
      chatSessionId,
      prompt,
      images,
      clientUserMessageId,
    });
  },
  aiSdkAgentListModels: async (sdkBackend, cwd, providerId, chatSessionId, agentEnv, agentCommand, codexRuntime, force) => {
    return ipcRenderer.invoke("quolldesk:ai:sdk-agent:list-models", { sdkBackend, cwd, providerId, chatSessionId, agentEnv, agentCommand, codexRuntime, force });
  },
  codexAppServerGetStatus: async (agentCommand, agentEnv) => {
    return ipcRenderer.invoke("quolldesk:ai:codex-app-server:status", { agentCommand, agentEnv });
  },
  onCodexAppServerInteractionRequest: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("quolldesk:ai:codex-app-server:interaction-request", handler);
    return () => ipcRenderer.removeListener("quolldesk:ai:codex-app-server:interaction-request", handler);
  },
  onCodexAppServerInteractionCleared: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("quolldesk:ai:codex-app-server:interaction-cleared", handler);
    return () => ipcRenderer.removeListener("quolldesk:ai:codex-app-server:interaction-cleared", handler);
  },
  respondCodexAppServerInteraction: async (payload) => {
    return ipcRenderer.invoke("quolldesk:ai:codex-app-server:interaction-response", payload);
  },
  cancelCodexAppServerInteractionTimeout: async (interactionId) => {
    return ipcRenderer.invoke("quolldesk:ai:codex-app-server:interaction-cancel-timeout", { interactionId });
  },
  aiSdkAgentCancel: async (requestId, chatSessionId) => {
    return ipcRenderer.invoke("quolldesk:ai:sdk-agent:cancel", { requestId, chatSessionId });
  },
  aiSdkAgentCleanup: async (chatSessionId) => {
    return ipcRenderer.invoke("quolldesk:ai:sdk-agent:cleanup", { chatSessionId });
  },
  aiSdkAgentElicitationResponse: async (elicitationId, action, content) => {
    return ipcRenderer.invoke("quolldesk:ai:sdk-agent:elicitation-response", { elicitationId, action, content });
  },
  aiSdkAgentMcpStatus: async (agentEnv, agentCommand) => {
    return ipcRenderer.invoke("quolldesk:ai:sdk-agent:mcp-status", { agentEnv, agentCommand });
  },
  aiSdkAgentAccountInfo: async (agentEnv, agentCommand) => {
    return ipcRenderer.invoke("quolldesk:ai:sdk-agent:account-info", { agentEnv, agentCommand });
  },
  aiSdkAgentPluginInstall: async (options) => {
    return ipcRenderer.invoke("quolldesk:ai:sdk-agent:plugin-install", { options });
  },
  aiSdkAgentPluginEnable: async (name, marketplace) => {
    return ipcRenderer.invoke("quolldesk:ai:sdk-agent:plugin-enable", { name, marketplace });
  },
  aiSdkAgentPluginDisable: async (name, marketplace) => {
    return ipcRenderer.invoke("quolldesk:ai:sdk-agent:plugin-disable", { name, marketplace });
  },
  aiSdkAgentMarketplaceInstall: async (options) => {
    return ipcRenderer.invoke("quolldesk:ai:sdk-agent:marketplace-install", { options });
  },
  aiSdkAgentMarketplaceRemove: async (options) => {
    return ipcRenderer.invoke("quolldesk:ai:sdk-agent:marketplace-remove", { options });
  },
  onAiSdkAgentEvent: (requestId, cb) => {
    const handler = (_event, payload) => {
      if (payload.requestId === requestId) cb(payload.event);
    };
    ipcRenderer.on("quolldesk:ai:sdk-agent:event", handler);
    return () => ipcRenderer.removeListener("quolldesk:ai:sdk-agent:event", handler);
  },
  onAiSdkAgentDone: (requestId, cb) => {
    const handler = (_event, payload) => {
      if (payload.requestId === requestId) cb();
    };
    ipcRenderer.on("quolldesk:ai:sdk-agent:done", handler);
    return () => ipcRenderer.removeListener("quolldesk:ai:sdk-agent:done", handler);
  },
  onAiSdkAgentError: (requestId, cb) => {
    const handler = (_event, payload) => {
      if (payload.requestId === requestId) cb(payload.error);
    };
    ipcRenderer.on("quolldesk:ai:sdk-agent:error", handler);
    return () => ipcRenderer.removeListener("quolldesk:ai:sdk-agent:error", handler);
  },
  onAiStreamData: (requestId, cb) => {
    const handler = (_event, payload) => {
      if (payload.requestId === requestId) cb(payload.data);
    };
    ipcRenderer.on("quolldesk:ai:stream:data", handler);
    return () => ipcRenderer.removeListener("quolldesk:ai:stream:data", handler);
  },
  onAiStreamEnd: (requestId, cb) => {
    const handler = (_event, payload) => {
      if (payload.requestId === requestId) cb();
    };
    ipcRenderer.on("quolldesk:ai:stream:end", handler);
    return () => ipcRenderer.removeListener("quolldesk:ai:stream:end", handler);
  },
  onAiStreamError: (requestId, cb) => {
    const handler = (_event, payload) => {
      if (payload.requestId === requestId) cb(payload.error);
    };
    ipcRenderer.on("quolldesk:ai:stream:error", handler);
    return () => ipcRenderer.removeListener("quolldesk:ai:stream:error", handler);
  },
  onAiAgentStdout: (agentId, cb) => {
    const handler = (_event, payload) => {
      if (payload.agentId === agentId) cb(payload.data);
    };
    ipcRenderer.on("quolldesk:ai:agent:stdout", handler);
    return () => ipcRenderer.removeListener("quolldesk:ai:agent:stdout", handler);
  },
  onAiAgentStderr: (agentId, cb) => {
    const handler = (_event, payload) => {
      if (payload.agentId === agentId) cb(payload.data);
    };
    ipcRenderer.on("quolldesk:ai:agent:stderr", handler);
    return () => ipcRenderer.removeListener("quolldesk:ai:agent:stderr", handler);
  },
  onAiAgentExit: (agentId, cb) => {
    const handler = (_event, payload) => {
      if (payload.agentId === agentId) cb(payload.code);
    };
    ipcRenderer.on("quolldesk:ai:agent:exit", handler);
    return () => ipcRenderer.removeListener("quolldesk:ai:agent:exit", handler);
  },
  scriptRun: async (params) => ipcRenderer.invoke("quolldesk:script:run", params),
  scriptStop: async (runId) => ipcRenderer.invoke("quolldesk:script:stop", { runId }),
  scriptPause: async (runId) => ipcRenderer.invoke("quolldesk:script:pause", { runId }),
  scriptResume: async (runId) => ipcRenderer.invoke("quolldesk:script:resume", { runId }),
  scriptGetRuns: async (sessionId) => ipcRenderer.invoke("quolldesk:script:get-runs", sessionId ? { sessionId } : {}),
  scriptDialogResponse: async (requestId, value, cancelled) =>
    ipcRenderer.invoke("quolldesk:script:dialog-response", { requestId, value, cancelled }),
  scriptScreenSnapshotResponse: async (requestId, snapshot) =>
    ipcRenderer.invoke("quolldesk:script:screen-snapshot-response", { requestId, snapshot }),
  scriptRecordingStart: async (sessionId) => ipcRenderer.invoke("quolldesk:script:recording:start", { sessionId }),
  scriptRecordingStop: async (sessionId) => ipcRenderer.invoke("quolldesk:script:recording:stop", { sessionId }),
  scriptRecordingAppendStep: async (sessionId, step) =>
    ipcRenderer.invoke("quolldesk:script:recording:append-step", { sessionId, step }),
  onScriptRunsUpdated: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("quolldesk:script:runs-updated", handler);
    return () => ipcRenderer.removeListener("quolldesk:script:runs-updated", handler);
  },
  onScriptDialogRequest: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("quolldesk:script:dialog-request", handler);
    return () => ipcRenderer.removeListener("quolldesk:script:dialog-request", handler);
  },
  onScriptScreenSnapshotRequest: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("quolldesk:script:screen-snapshot-request", handler);
    return () => ipcRenderer.removeListener("quolldesk:script:screen-snapshot-request", handler);
  },
  onScriptSessionInput: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("quolldesk:script:session-input", handler);
    return () => ipcRenderer.removeListener("quolldesk:script:session-input", handler);
  },
    };
  }
}

module.exports = { createPreloadApi };
