const assert = require("node:assert/strict");
const test = require("node:test");
const { createPreloadApi } = require("./api.cjs");

test("local file drag exposes only the dedicated start and cancellation channels", async () => {
  const calls = [];
  const api = createPreloadApi({ ipcRenderer: {
    invoke: async (...args) => { calls.push(args); return { started: true }; },
    send: (...args) => calls.push(args),
  }, webUtils: {} });
  const payload = { requestId: "one", paths: ["/file"] };
  assert.deepEqual(await api.startLocalFileDrag(payload), { started: true });
  api.cancelLocalFileDrag("one");
  assert.deepEqual(calls, [["quolldesk:local:drag-start", payload], ["quolldesk:local:drag-cancel", { requestId: "one" }]]);
});
