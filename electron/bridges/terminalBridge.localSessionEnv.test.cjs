const test = require("node:test");
const assert = require("node:assert/strict");

function loadBridgeWithFakePty() {
  const bridgePath = require.resolve("./terminalBridge.cjs");
  delete require.cache[bridgePath];
  const bridge = require("./terminalBridge.cjs");
  // node-pty/serialport load lazily now; stub them through the bridge hooks
  // instead of intercepting the require at load time.
  bridge._setPtyForTests({
    spawn() {
      throw new Error("node-pty spawn is not exercised by this suite");
    },
  });
  bridge._setSerialPortForTests(class SerialPort {});
  return bridge;
}

const bridge = loadBridgeWithFakePty();

// A captured PATH whose herdr entry points at the release directory an upgrade
// replaced, which is exactly how "works in cmd, not in QuollDesk" shows up.
const STALE_PATH =
  "C:\\Users\\me\\.herdr\\packages\\standalone\\releases\\0.8.2-x86_64-pc-windows-msvc;C:\\Windows\\System32";
const LIVE_PATH =
  "C:\\Users\\me\\.herdr\\packages\\standalone\\releases\\0.9.1-x86_64-pc-windows-msvc;C:\\Windows\\System32";

test("buildLocalSessionEnv strips AppImage ARGV0 without changing the base env", async () => {
  const baseEnv = { PATH: "/usr/bin:/bin", ARGV0: "/opt/QuollDesk.AppImage" };
  const env = await bridge.buildLocalSessionEnv({}, { baseEnv, platform: "linux" });

  assert.equal(Object.hasOwn(env, "ARGV0"), false);
  assert.equal(env.PATH, baseEnv.PATH);
  assert.equal(baseEnv.ARGV0, "/opt/QuollDesk.AppImage");
});

test("buildLocalSessionEnv keeps the captured PATH untouched off Windows", async () => {
  const env = await bridge.buildLocalSessionEnv(
    { env: { QUOLLDESK_MARKER: "1" } },
    {
      baseEnv: { PATH: "/usr/bin:/bin", HOME: "/home/me" },
      platform: "darwin",
    },
  );

  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.HOME, "/home/me");
  assert.equal(env.QUOLLDESK_MARKER, "1");
});

test("buildLocalSessionEnv refreshes PATH from the registry on Windows", async () => {
  const calls = [];
  const env = await bridge.buildLocalSessionEnv(
    {},
    {
      baseEnv: { Path: STALE_PATH, SystemRoot: "C:\\Windows" },
      platform: "win32",
      refreshWindowsPath: async (options) => {
        calls.push(options);
        return LIVE_PATH;
      },
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].basePath, STALE_PATH);
  assert.equal(calls[0].platform, "win32");
  assert.equal(env.Path, LIVE_PATH);
  assert.equal(env.PATH, undefined);
  assert.equal(env.SystemRoot, "C:\\Windows");
});

test("buildLocalSessionEnv collapses a duplicate PATH sitting next to Path", async () => {
  const env = await bridge.buildLocalSessionEnv(
    {},
    {
      baseEnv: { Path: STALE_PATH, PATH: STALE_PATH },
      platform: "win32",
      refreshWindowsPath: () => LIVE_PATH,
    },
  );

  assert.equal(env.Path, LIVE_PATH);
  assert.equal(env.PATH, undefined);
  assert.equal(
    Object.keys(env).filter((key) => key.toLowerCase() === "path").length,
    1,
  );
});

test("buildLocalSessionEnv never widens an explicit PATH override", async () => {
  let refreshed = false;
  const env = await bridge.buildLocalSessionEnv(
    { env: { PATH: "C:\\pinned\\bin" } },
    {
      baseEnv: { Path: STALE_PATH },
      platform: "win32",
      refreshWindowsPath: () => {
        refreshed = true;
        return LIVE_PATH;
      },
    },
  );

  assert.equal(refreshed, false);
  assert.equal(env.PATH, "C:\\pinned\\bin");
  assert.equal(env.Path, undefined);
});

for (const pathKey of ["Path", "PATH", "path"]) {
  test(`an explicit empty ${pathKey} override stays empty without a registry query`, async () => {
    const env = await bridge.buildLocalSessionEnv(
      { env: { [pathKey]: "" } },
      {
        baseEnv: { Path: STALE_PATH, PATH: STALE_PATH },
        platform: "win32",
        refreshWindowsPath: () => { throw new Error("must not refresh an explicit override"); },
      },
    );
    assert.equal(env[pathKey], "");
    assert.deepEqual(Object.keys(env).filter((key) => key.toLowerCase() === "path"), [pathKey]);
  });
}
