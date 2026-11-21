"use strict";

/**
 * Bootstrap for external MCP clients.
 * Reads the external discovery file written by QuollDesk, sets env, then
 * loads the existing catalog-backed stdio MCP server.
 */

const fs = require("node:fs");
const path = require("node:path");

const {
  resolveExistingExternalMcpDiscoveryFilePath,
  EXTERNAL_MCP_CHAT_SESSION_ID,
} = require("../cli/externalMcpDiscoveryPath.cjs");
const { readExternalDiscovery } = require("../cli/externalMcpDiscovery.cjs");

function resolveDiscoveryPath() {
  return resolveExistingExternalMcpDiscoveryFilePath();
}

function main() {
  const discoveryPath = resolveDiscoveryPath();
  if (!fs.existsSync(discoveryPath)) {
    process.stderr.write(
      `[quolldesk-external-mcp] Discovery file not found at ${discoveryPath}. ` +
      "Enable External MCP in QuollDesk Settings → AI and keep the app running.\n",
    );
    process.exit(1);
  }

  let discovery;
  try {
    discovery = readExternalDiscovery(discoveryPath);
  } catch (error) {
    process.stderr.write(
      `[quolldesk-external-mcp] Failed to read discovery: ${error?.message || error}\n`,
    );
    process.exit(1);
  }

  process.env.QUOLLDESK_EXTERNAL_MCP_DISCOVERY_FILE = discoveryPath;
  process.env.QUOLLDESK_MCP_PORT = String(discovery.port);
  process.env.QUOLLDESK_MCP_TOKEN = discovery.token;
  process.env.QUOLLDESK_MCP_CHAT_SESSION_ID = discovery.chatSessionId || EXTERNAL_MCP_CHAT_SESSION_ID;
  process.env.QUOLLDESK_MCP_PERMISSION_MODE = discovery.permissionMode || "confirm";

  // Load after env is set — quolldesk-mcp-server reads env at module load.
  require(path.join(__dirname, "quolldesk-mcp-server.cjs"));
}

main();
