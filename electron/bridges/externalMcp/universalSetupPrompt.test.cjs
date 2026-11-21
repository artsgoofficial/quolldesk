"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildUniversalSetupPrompt } = require("./universalSetupPrompt.cjs");

test("builds a portable MCP and Skill installation prompt", () => {
  const prompt = buildUniversalSetupPrompt({
    launcherPath: "/Applications/QuollDesk App/quolldesk-external-mcp",
    discoveryPath: "/Users/test/Library/Application Support/QuollDesk/discovery.json",
    skillContent: "---\nname: quolldesk-mcp\nmetadata:\n  managed-by: quolldesk\n---\nUse get_environment first.\n",
  });

  assert.match(prompt, /Install the QuollDesk integration/);
  assert.match(prompt, /Agent Skills are unsupported/);
  assert.match(prompt, /managed-by: quolldesk/);
  assert.match(prompt, /call `get_environment`/);

  const jsonBlock = prompt.match(/```json\n([\s\S]*?)\n```/u)?.[1];
  assert.ok(jsonBlock);
  assert.deepEqual(JSON.parse(jsonBlock), {
    mcpServers: {
      "quolldesk-external": {
        command: "/Applications/QuollDesk App/quolldesk-external-mcp",
        args: [],
        env: {
          QUOLLDESK_EXTERNAL_MCP_DISCOVERY_FILE: "/Users/test/Library/Application Support/QuollDesk/discovery.json",
        },
      },
    },
  });
});

test("requires all runtime-specific installation values", () => {
  assert.throws(
    () => buildUniversalSetupPrompt({ launcherPath: "", discoveryPath: "/tmp/d", skillContent: "skill" }),
    /launcher path is unavailable/i,
  );
  assert.throws(
    () => buildUniversalSetupPrompt({ launcherPath: "/bin/mcp", discoveryPath: "", skillContent: "skill" }),
    /discovery path is unavailable/i,
  );
  assert.throws(
    () => buildUniversalSetupPrompt({ launcherPath: "/bin/mcp", discoveryPath: "/tmp/d", skillContent: "" }),
    /skill content is unavailable/i,
  );
});
