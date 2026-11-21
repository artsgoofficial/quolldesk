"use strict";

const { ipcRenderer } = require("electron");

let hostPort;
let runtimeReady = false;

function connectRuntime() {
  if (!hostPort || !runtimeReady) return;
  const port = hostPort;
  hostPort = undefined;
  window.postMessage({
    type: "quolldesk-plugin:connect",
    runtimeToken: window.location.hostname,
  }, "*", [port]);
}

window.addEventListener("message", (event) => {
  if (event.data?.runtimeToken !== window.location.hostname) return;
  if (event.data?.type === "quolldesk-plugin:runtime-ready") {
    runtimeReady = true;
    connectRuntime();
  } else if (event.data?.type === "quolldesk-plugin:runtime-connected") {
    ipcRenderer.send("quolldesk-plugin:runtime-connected");
  }
});

ipcRenderer.once("quolldesk-plugin:connect", (event) => {
  hostPort = event.ports?.[0];
  connectRuntime();
});
ipcRenderer.send("quolldesk-plugin:preload-ready");
