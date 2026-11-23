import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "HostTreeContextMenus.tsx"),
  "utf8",
);

test("host context menu offers dual-pane SFTP without extra prop drilling", () => {
  assert.match(source, /OpenDualPaneSftpMenuItem/);
  assert.match(source, /requestOpenDualPaneSftp/);
  assert.match(source, /vault\.hosts\.openSftp/);
  assert.match(source, /useSettingsChromeStore/);
  assert.match(source, /!showSftpTab\s*\|\|\s*!canOpenDualPaneSftp/);
});

test("host context menu branches on db protocol: SFTP item gated, connection-string item db-only", () => {
  // SFTP item must stay self-gating (domain guard excludes db protocols), and
  // the connection-string item must render only for db protocols.
  assert.match(source, /import\s*\{[^}]*\bisDbProtocol\b[^}]*\}\s*from\s*'\.\.\/\.\.\/domain\/models\/database'/s);
  assert.match(source, /CopyDbConnectionStringMenuItem/);
  assert.match(source, /vault\.hosts\.copyConnectionString/);
  assert.match(
    source,
    /isDbProtocol\(safeHost\.protocol\)\s*\?\s*[\s\S]*?CopyDbConnectionStringMenuItem/,
    "connection-string item is rendered only on the db branch",
  );
});

test("CopyDbConnectionStringMenuItem is self-contained: builds string, copies, toasts", () => {
  assert.match(source, /buildDbConnectionString/);
  assert.match(source, /navigator\.clipboard\.writeText/);
  assert.match(source, /copyConnectionString\.toast\.success/);
  // Only rendered for db protocols; non-db protocols get null.
  assert.match(source, /if\s*\(\s*!isDbProtocol\(host\.protocol\)\s*\)\s*return\s+null/);
});
