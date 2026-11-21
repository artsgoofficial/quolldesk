const assert = require("node:assert/strict");
const test = require("node:test");

const terminalBridge = require("./terminalBridge.cjs");
const sshBridge = require("./sshBridge.cjs");
const keyboardInteractiveHandler = require("./keyboardInteractiveHandler.cjs");
const passphraseHandler = require("./passphraseHandler.cjs");
const hostKeyVerifier = require("./hostKeyVerifier.cjs");
const sftpBridge = require("./sftpBridge.cjs");
const transferBridge = require("./transferBridge.cjs");
const compressUploadBridge = require("./compressUploadBridge.cjs");
const fileWatcherBridge = require("./fileWatcherBridge.cjs");
const { createSystemManagerBridge } = require("./systemManagerBridge.cjs");

function createFakeIpcMain() {
  return {
    handlers: new Map(),
    listeners: new Map(),
    handle(channel, handler) {
      this.handlers.set(channel, handler);
    },
    on(channel, listener) {
      this.listeners.set(channel, listener);
    },
  };
}

function createFakeWorkerManager() {
  const requests = [];
  const sends = [];
  return {
    requests,
    sends,
    request(channel, payload, options) {
      requests.push({ channel, payload, options });
      return Promise.resolve({ ok: true, channel });
    },
    send(channel, payload, options) {
      sends.push({ channel, payload, options });
    },
  };
}

const fakeEvent = { sender: { id: 42 } };

test("terminal worker mode proxies all terminal starts and control commands", async () => {
  const ipcMain = createFakeIpcMain();
  const terminalWorkerManager = createFakeWorkerManager();

  terminalBridge.registerHandlers(ipcMain, { terminalWorkerManager });

  for (const channel of [
    "quolldesk:local:start",
    "quolldesk:telnet:start",
    "quolldesk:mosh:start",
    "quolldesk:et:start",
    "quolldesk:serial:start",
    "quolldesk:close:await",
  ]) {
    assert.equal(ipcMain.handlers.has(channel), true, `${channel} should be proxied as a request`);
    await ipcMain.handlers.get(channel)(fakeEvent, { sessionId: channel });
  }

  for (const channel of [
    "quolldesk:write",
    "quolldesk:interrupt",
    "quolldesk:resize",
    "quolldesk:pty:clear",
    "quolldesk:flow",
    "quolldesk:flow:ack",
    "quolldesk:close",
  ]) {
    assert.equal(ipcMain.listeners.has(channel), true, `${channel} should be proxied as a send`);
    ipcMain.listeners.get(channel)(fakeEvent, { sessionId: channel });
  }

  assert.deepEqual(
    terminalWorkerManager.requests.map((entry) => entry.channel),
    [
      "quolldesk:local:start",
      "quolldesk:telnet:start",
      "quolldesk:mosh:start",
      "quolldesk:et:start",
      "quolldesk:serial:start",
      "quolldesk:close:await",
    ],
  );
  assert.deepEqual(
    terminalWorkerManager.sends.map((entry) => entry.channel),
    [
      "quolldesk:write",
      "quolldesk:interrupt",
      "quolldesk:resize",
      "quolldesk:pty:clear",
      "quolldesk:flow",
      "quolldesk:flow:ack",
      "quolldesk:close",
    ],
  );
});

test("terminal worker mode proxies SSH session and remote helper requests", async () => {
  const ipcMain = createFakeIpcMain();
  const terminalWorkerManager = createFakeWorkerManager();

  sshBridge.registerHandlers(ipcMain, { terminalWorkerManager });

  for (const channel of [
    "quolldesk:start",
    "quolldesk:ssh:exec",
    "quolldesk:ssh:pwd",
    "quolldesk:ssh:remoteInfo",
    "quolldesk:ssh:distroInfo",
    "quolldesk:ssh:readRemoteHistory",
    "quolldesk:ssh:listdir",
    "quolldesk:ssh:stats",
    "quolldesk:ssh:setEncoding",
  ]) {
    assert.equal(ipcMain.handlers.has(channel), true, `${channel} should be proxied`);
    await ipcMain.handlers.get(channel)(fakeEvent, { sessionId: "ssh-1" });
  }

  assert.deepEqual(
    terminalWorkerManager.requests.map((entry) => entry.channel),
    [
      "quolldesk:start",
      "quolldesk:ssh:exec",
      "quolldesk:ssh:pwd",
      "quolldesk:ssh:remoteInfo",
      "quolldesk:ssh:distroInfo",
      "quolldesk:ssh:readRemoteHistory",
      "quolldesk:ssh:listdir",
      "quolldesk:ssh:stats",
      "quolldesk:ssh:setEncoding",
    ],
  );
  assert.equal(
    terminalWorkerManager.requests[0].payload._macLocalNetworkMainProbed,
    true,
    "worker start payload should skip a second Local Network probe",
  );
});

test("terminal worker mode keeps main-process keyboard-interactive responses in the main process", async () => {
  const ipcMain = createFakeIpcMain();
  const terminalWorkerManager = createFakeWorkerManager();
  const requestId = keyboardInteractiveHandler.generateRequestId("port-forward");
  let receivedResponses = null;

  keyboardInteractiveHandler.storeRequest(
    requestId,
    (responses) => {
      receivedResponses = responses;
    },
    fakeEvent.sender.id,
    "tunnel-1",
  );
  sshBridge.registerHandlers(ipcMain, { terminalWorkerManager });

  const result = await ipcMain.handlers.get("quolldesk:keyboard-interactive:respond")(
    fakeEvent,
    { requestId, responses: ["123456"], cancelled: false },
  );

  const remainedPending = keyboardInteractiveHandler.getRequests().has(requestId);
  if (remainedPending) {
    keyboardInteractiveHandler.handleResponse(fakeEvent, {
      requestId,
      responses: [],
      cancelled: true,
    });
  }

  assert.deepEqual(result, { success: true });
  assert.deepEqual(receivedResponses, ["123456"]);
  assert.equal(remainedPending, false);
  assert.equal(terminalWorkerManager.requests.length, 0);
});

test("terminal worker mode keeps main-process passphrase responses in the main process", async () => {
  const ipcMain = createFakeIpcMain();
  const terminalWorkerManager = createFakeWorkerManager();
  const sent = [];
  const sender = {
    id: fakeEvent.sender.id,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
  const responsePromise = passphraseHandler.requestPassphrase(
    sender,
    "/tmp/test-key",
    "test-key",
    "example.com",
    false,
  );
  const requestId = sent[0].payload.requestId;
  sshBridge.registerHandlers(ipcMain, { terminalWorkerManager });

  const wrongResult = await ipcMain.handlers.get("quolldesk:passphrase:respond")(
    { sender: { id: fakeEvent.sender.id + 1 } },
    { requestId, passphrase: "stolen", cancelled: false },
  );
  assert.deepEqual(wrongResult, { success: false, error: "Wrong sender" });
  assert.equal(passphraseHandler.getRequests().has(requestId), true);

  const result = await ipcMain.handlers.get("quolldesk:passphrase:respond")(
    fakeEvent,
    { requestId, passphrase: "secret", cancelled: false },
  );

  assert.deepEqual(result, { success: true });
  assert.deepEqual(await responsePromise, { passphrase: "secret" });
  assert.equal(passphraseHandler.getRequests().has(requestId), false);
  assert.equal(terminalWorkerManager.requests.length, 0);
});

test("terminal worker mode keeps main-process host-key responses in the main process", async () => {
  const ipcMain = createFakeIpcMain();
  const terminalWorkerManager = createFakeWorkerManager();
  const sent = [];
  const sender = {
    id: fakeEvent.sender.id,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
  const responsePromise = hostKeyVerifier.requestHostKeyVerification(sender, {
    sessionId: "tunnel-1",
    hostname: "example.com",
    port: 22,
    status: "unknown",
  });
  const requestId = sent[0].payload.requestId;
  sshBridge.registerHandlers(ipcMain, { terminalWorkerManager });

  const wrongResult = await ipcMain.handlers.get("quolldesk:host-key:respond")(
    { sender: { id: fakeEvent.sender.id + 1 } },
    { requestId, accept: true, addToKnownHosts: false },
  );
  assert.deepEqual(wrongResult, { success: false, error: "Wrong sender" });
  assert.equal(hostKeyVerifier.getRequests().has(requestId), true);

  const result = await ipcMain.handlers.get("quolldesk:host-key:respond")(
    fakeEvent,
    { requestId, accept: true, addToKnownHosts: false },
  );

  assert.deepEqual(result, { success: true });
  assert.deepEqual(await responsePromise, { accept: true, addToKnownHosts: false });
  assert.equal(hostKeyVerifier.getRequests().has(requestId), false);
  assert.equal(terminalWorkerManager.requests.length, 0);
});

test("terminal worker mode forwards worker-owned authentication responses", async () => {
  const ipcMain = createFakeIpcMain();
  const terminalWorkerManager = createFakeWorkerManager();
  sshBridge.registerHandlers(ipcMain, { terminalWorkerManager });

  for (const channel of [
    "quolldesk:keyboard-interactive:respond",
    "quolldesk:passphrase:respond",
    "quolldesk:host-key:respond",
  ]) {
    const result = await ipcMain.handlers.get(channel)(fakeEvent, { requestId: `worker-${channel}` });
    assert.deepEqual(result, { ok: true, channel });
  }

  assert.deepEqual(
    terminalWorkerManager.requests.map((entry) => entry.channel),
    [
      "quolldesk:keyboard-interactive:respond",
      "quolldesk:passphrase:respond",
      "quolldesk:host-key:respond",
    ],
  );
});

test("terminal worker mode proxies SFTP and surrounding file operations", async () => {
  const ipcMain = createFakeIpcMain();
  const terminalWorkerManager = createFakeWorkerManager();

  sftpBridge.registerHandlers(ipcMain, { terminalWorkerManager });
  transferBridge.registerHandlers(ipcMain, { terminalWorkerManager });
  compressUploadBridge.registerHandlers(ipcMain, { terminalWorkerManager });
  fileWatcherBridge.registerHandlers(ipcMain, { terminalWorkerManager });

  for (const channel of [
    "quolldesk:sftp:openForSession",
    "quolldesk:sftp:list",
    "quolldesk:sftp:write",
    "quolldesk:sftp:downloadToLocal",
    "quolldesk:sftp:uploadLocal",
    "quolldesk:sftp:close",
    "quolldesk:transfer:start",
    "quolldesk:transfer:retain-sftp-session",
    "quolldesk:transfer:release-sftp-session",
    "quolldesk:transfer:cancel",
    "quolldesk:compress:start",
    "quolldesk:compress:checkSupport",
    "quolldesk:filewatch:start",
    "quolldesk:filewatch:registerTempFile",
  ]) {
    assert.equal(ipcMain.handlers.has(channel), true, `${channel} should be proxied`);
    await ipcMain.handlers.get(channel)(fakeEvent, { sessionId: "ssh-1", sftpId: "sftp-1" });
  }

  assert.deepEqual(
    terminalWorkerManager.requests.map((entry) => entry.channel),
    [
      "quolldesk:sftp:openForSession",
      "quolldesk:sftp:list",
      "quolldesk:sftp:write",
      "quolldesk:sftp:downloadToLocal",
      "quolldesk:sftp:uploadLocal",
      "quolldesk:sftp:close",
      "quolldesk:transfer:start",
      "quolldesk:transfer:retain-sftp-session",
      "quolldesk:transfer:release-sftp-session",
      "quolldesk:transfer:cancel",
      "quolldesk:compress:start",
      "quolldesk:compress:checkSupport",
      "quolldesk:filewatch:start",
      "quolldesk:filewatch:registerTempFile",
    ],
  );
});

test("terminal worker mode proxies system management requests", async () => {
  const ipcMain = createFakeIpcMain();
  const terminalWorkerManager = createFakeWorkerManager();
  const systemManagerBridge = createSystemManagerBridge({
    getSessions: () => new Map(),
    execOnEtSession: () => {},
    ensureMoshStatsConnection: () => {},
    process,
  });

  systemManagerBridge.registerHandlers(ipcMain, { terminalWorkerManager });

  for (const channel of [
    "quolldesk:system:probeCapabilities",
    "quolldesk:system:listProcesses",
    "quolldesk:system:setupOsc7Tracking",
    "quolldesk:system:listTmuxSessions",
    "quolldesk:system:listDockerContainers",
    "quolldesk:system:listAccelerators",
  ]) {
    assert.equal(ipcMain.handlers.has(channel), true, `${channel} should be proxied`);
    await ipcMain.handlers.get(channel)(fakeEvent, { sessionId: "ssh-1" });
  }

  assert.deepEqual(
    terminalWorkerManager.requests.map((entry) => entry.channel),
    [
      "quolldesk:system:probeCapabilities",
      "quolldesk:system:listProcesses",
      "quolldesk:system:setupOsc7Tracking",
      "quolldesk:system:listTmuxSessions",
      "quolldesk:system:listDockerContainers",
      "quolldesk:system:listAccelerators",
    ],
  );
});

test("fallback log restart guard wraps all six starts only when main explicitly enables it", (t) => {
  const manager = require("./sessionLogStreamManager.cjs");
  const wrappers = new Map();
  t.mock.method(manager, "withSessionLogRestart", (handler) => {
    const wrapped = () => {};
    wrappers.set(handler, wrapped);
    return wrapped;
  });
  const workerHandlers = createFakeIpcMain();
  sshBridge.registerHandlers(workerHandlers);
  terminalBridge.registerHandlers(workerHandlers);
  assert.equal(wrappers.size, 0, "utility-process registration keeps the runtime generation guard");

  const fallbackHandlers = createFakeIpcMain();
  sshBridge.registerHandlers(fallbackHandlers, { manageSessionLogRestart: true });
  terminalBridge.registerHandlers(fallbackHandlers, { manageSessionLogRestart: true });
  const startChannels = [
    "quolldesk:start", "quolldesk:local:start", "quolldesk:telnet:start",
    "quolldesk:mosh:start", "quolldesk:et:start", "quolldesk:serial:start",
  ];
  assert.equal(wrappers.size, startChannels.length);
  for (const channel of startChannels) {
    assert.equal(fallbackHandlers.handlers.get(channel), wrappers.get(workerHandlers.handlers.get(channel)), channel);
  }
  assert.equal(fallbackHandlers.handlers.get("quolldesk:serial:list"), workerHandlers.handlers.get("quolldesk:serial:list"));

  wrappers.clear();
  const proxyHandlers = createFakeIpcMain();
  const terminalWorkerManager = createFakeWorkerManager();
  sshBridge.registerHandlers(proxyHandlers, { terminalWorkerManager, manageSessionLogRestart: true });
  terminalBridge.registerHandlers(proxyHandlers, { terminalWorkerManager, manageSessionLogRestart: true });
  assert.equal(wrappers.size, 0, "worker proxies must not also apply the main fallback guard");
});
