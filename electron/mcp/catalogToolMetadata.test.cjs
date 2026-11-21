const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getCatalogToolDescription,
  listCatalogMcpToolNames,
  setDatabaseToolsEnabled,
} = require("./catalogToolMetadata.cjs");

test("database tools are listed by default and hidden when disabled", () => {
  const names = listCatalogMcpToolNames();
  assert.ok(names.includes("database_query"));
  assert.ok(names.includes("redis_command"));
  assert.ok(names.includes("terminal_execute"));
  assert.ok(getCatalogToolDescription("database_query"));

  setDatabaseToolsEnabled(false);
  const filtered = listCatalogMcpToolNames();
  assert.ok(!filtered.includes("database_query"));
  assert.ok(!filtered.includes("redis_command"));
  assert.ok(!filtered.includes("redis_keys_scan"));
  assert.equal(getCatalogToolDescription("database_query"), null);
  // non-database tools survive the filter
  assert.ok(filtered.includes("terminal_execute"));
  assert.ok(getCatalogToolDescription("terminal_execute"));

  setDatabaseToolsEnabled(true);
  assert.ok(listCatalogMcpToolNames().includes("database_query"));
});
