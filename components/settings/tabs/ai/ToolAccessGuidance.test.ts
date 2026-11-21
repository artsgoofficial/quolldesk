import assert from "node:assert/strict";
import test from "node:test";

import { buildMcpOnboardingPrompt } from "./ToolAccessGuidance";

test("buildMcpOnboardingPrompt includes launcher and discovery env", () => {
  const prompt = buildMcpOnboardingPrompt("/opt/quolldesk/launcher", "/tmp/discovery.json");
  assert.match(prompt, /quolldesk-external/);
  assert.match(prompt, /\/opt\/quolldesk\/launcher/);
  assert.match(prompt, /QUOLLDESK_EXTERNAL_MCP_DISCOVERY_FILE=\/tmp\/discovery\.json/);
  assert.match(prompt, /get_environment/);
});

test("buildMcpOnboardingPrompt omits env line without discovery path", () => {
  const prompt = buildMcpOnboardingPrompt("/opt/quolldesk/launcher", null);
  assert.match(prompt, /\/opt\/quolldesk\/launcher/);
  assert.doesNotMatch(prompt, /QUOLLDESK_EXTERNAL_MCP_DISCOVERY_FILE=/);
});

test("buildMcpOnboardingPrompt falls back to enable-External-MCP guidance", () => {
  const prompt = buildMcpOnboardingPrompt(null, null);
  assert.match(prompt, /External MCP/);
  assert.doesNotMatch(prompt, /Command: /);
});
