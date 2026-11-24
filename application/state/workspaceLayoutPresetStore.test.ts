import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkspaceLayoutPreset,
  sanitizeWorkspaceLayoutPreset,
} from "../../domain/workspaceLayoutPreset.ts";
import {
  clearWorkspaceLayoutPreset,
  readWorkspaceLayoutPreset,
  writeWorkspaceLayoutPreset,
} from "./workspaceLayoutPresetStore.ts";

const STORAGE_KEY = "quolldesk_workspace_layout_preset_v1";

function fakeLocalStorage(t: {
  after: (cb: () => void) => void;
}): Map<string, string> {
  const values = new Map<string, string>();
  const globals = globalThis as typeof globalThis & { localStorage?: Storage };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
    configurable: true,
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete (globals as { localStorage?: Storage }).localStorage;
  });
  return values;
}

test("write/read roundtrip stores the preset and clear drops it", (t) => {
  const values = fakeLocalStorage(t);

  assert.equal(readWorkspaceLayoutPreset(), null);

  const layout = { root: { id: "pane-1", type: "pane" as const, tool: "sftp" as const }, focusedPaneId: "pane-1" };
  const preset = createWorkspaceLayoutPreset(layout);
  assert.ok(preset);
  assert.equal(writeWorkspaceLayoutPreset(preset), true);

  const readBack = readWorkspaceLayoutPreset();
  assert.ok(readBack);
  assert.deepEqual(readBack, preset);

  clearWorkspaceLayoutPreset();
  assert.equal(values.has(STORAGE_KEY), false);
  assert.equal(readWorkspaceLayoutPreset(), null);

  // Clearing again stays a no-op (nothing persisted, no change event).
  clearWorkspaceLayoutPreset();
  assert.equal(readWorkspaceLayoutPreset(), null);
});

test("unreadable persisted data sanitizes to null", (t) => {
  fakeLocalStorage(t);
  const globals = globalThis as typeof globalThis & { localStorage?: Storage };
  globals.localStorage?.setItem(STORAGE_KEY, "not json at all");
  assert.equal(readWorkspaceLayoutPreset(), null);
  globals.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ version: 99, layout: {} }));
  assert.equal(readWorkspaceLayoutPreset(), null);
  assert.equal(sanitizeWorkspaceLayoutPreset(null), null);
});
