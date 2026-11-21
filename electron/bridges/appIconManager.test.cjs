"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const appIconManager = require("./appIconManager.cjs");

test("resolveOriginalIconPath prefers public sources in dev when both exist", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quolldesk-icon-dev-"));
  const publicPath = path.join(tmp, "public", "icons", "variants", "original.png");
  const distPath = path.join(tmp, "dist", "icons", "variants", "original.png");
  fs.mkdirSync(path.dirname(publicPath), { recursive: true });
  fs.mkdirSync(path.dirname(distPath), { recursive: true });
  fs.writeFileSync(publicPath, "public-new");
  fs.writeFileSync(distPath, "dist-old");

  appIconManager.initializeAppIconManager(tmp, { preferPublic: true });
  assert.equal(appIconManager.resolveOriginalIconPath(tmp), publicPath);
  assert.equal(appIconManager.getAppIconPath(tmp), publicPath);
});

test("resolveOriginalIconPath prefers dist sources when packaged", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quolldesk-icon-packaged-"));
  const publicPath = path.join(tmp, "public", "icons", "variants", "original.png");
  const distPath = path.join(tmp, "dist", "icons", "variants", "original.png");
  fs.mkdirSync(path.dirname(publicPath), { recursive: true });
  fs.mkdirSync(path.dirname(distPath), { recursive: true });
  fs.writeFileSync(publicPath, "public-new");
  fs.writeFileSync(distPath, "dist-packaged");

  appIconManager.initializeAppIconManager(tmp, { preferPublic: false });
  assert.equal(appIconManager.resolveOriginalIconPath(tmp), distPath);
});

test("original icon uses platform-specific sizing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quolldesk-icon-platform-"));
  const publicDir = path.join(tmp, "public");
  fs.mkdirSync(publicDir, { recursive: true });
  const macPath = path.join(publicDir, "icons", "variants", "macos", "original.png");
  const desktopPath = path.join(publicDir, "icons", "variants", "original.png");
  fs.mkdirSync(path.dirname(macPath), { recursive: true });
  fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
  fs.writeFileSync(macPath, "mac");
  fs.writeFileSync(desktopPath, "desktop");

  appIconManager.initializeAppIconManager(tmp, { preferPublic: true, isMac: true });
  assert.equal(appIconManager.resolveOriginalIconPath(tmp), macPath);

  appIconManager.initializeAppIconManager(tmp, { preferPublic: true, isMac: false });
  assert.equal(appIconManager.resolveOriginalIconPath(tmp), desktopPath);
});

test("non-mac icons fall back to the packaged icon PNGs when the runtime asset is missing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quolldesk-icon-fallback-"));
  const publicDir = path.join(tmp, "public");
  fs.mkdirSync(publicDir, { recursive: true });
  const winIconPath = path.join(publicDir, "icon-win.png");
  fs.writeFileSync(winIconPath, "full-bleed");

  appIconManager.initializeAppIconManager(tmp, { preferPublic: true, isMac: false });
  assert.equal(appIconManager.resolveOriginalIconPath(tmp), winIconPath);
});
