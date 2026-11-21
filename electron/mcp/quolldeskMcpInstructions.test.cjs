"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  QUOLLDESK_MCP_SERVER_INSTRUCTIONS,
} = require("./quolldeskMcpInstructions.cjs");

test("MCP server instructions route QuollDesk terminal work through environment discovery", () => {
  assert.ok(QUOLLDESK_MCP_SERVER_INSTRUCTIONS.length <= 512);
  assert.match(QUOLLDESK_MCP_SERVER_INSTRUCTIONS, /call get_environment first/i);
  assert.match(QUOLLDESK_MCP_SERVER_INSTRUCTIONS, /label or hostname/i);
  assert.match(QUOLLDESK_MCP_SERVER_INSTRUCTIONS, /sessionId/);
  assert.match(QUOLLDESK_MCP_SERVER_INSTRUCTIONS, /Never use the local shell/i);
  assert.match(QUOLLDESK_MCP_SERVER_INSTRUCTIONS, /vault_hosts_list and host_open/);
  assert.match(QUOLLDESK_MCP_SERVER_INSTRUCTIONS, /load_quolldesk_tools/);
  assert.match(QUOLLDESK_MCP_SERVER_INSTRUCTIONS, /15 core tools/);
});

test("stdio MCP server publishes the routing instructions during initialization", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "quolldesk-mcp-server.cjs"),
    "utf8",
  );
  assert.match(source, /instructions:\s*QUOLLDESK_MCP_SERVER_INSTRUCTIONS/);
});
