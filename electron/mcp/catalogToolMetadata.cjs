"use strict";

const { listMcpTools } = require("../capabilities/codegen/toolSurfaces.cjs");

const mcpToolDescriptions = new Map(
  listMcpTools().map((tool) => [tool.mcpTool, { description: tool.description, domain: tool.domain }]),
);

// "AI database access" master switch (spec §6): when disabled, database/redis
// capability tools disappear from the MCP tool listing. The flag is synced
// from the renderer via quolldesk:ai:mcp:set-db-access-enabled.
let databaseToolsEnabled = true;

function isDatabaseDomain(domain) {
  return domain === "database" || domain === "redis";
}

function setDatabaseToolsEnabled(enabled) {
  databaseToolsEnabled = enabled !== false;
}

function areDatabaseToolsEnabled() {
  return databaseToolsEnabled;
}

function getCatalogToolDescription(toolName) {
  const entry = mcpToolDescriptions.get(toolName);
  if (!entry) return null;
  if (!databaseToolsEnabled && isDatabaseDomain(entry.domain)) return null;
  return entry.description;
}

function listCatalogMcpToolNames() {
  return [...mcpToolDescriptions.entries()]
    .filter(([, entry]) => databaseToolsEnabled || !isDatabaseDomain(entry.domain))
    .map(([toolName]) => toolName);
}

module.exports = {
  getCatalogToolDescription,
  listCatalogMcpToolNames,
  setDatabaseToolsEnabled,
  areDatabaseToolsEnabled,
};
