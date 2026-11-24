import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import {
  collectSidePanelPanes,
  getFocusedSidePanelPane,
  type SidePanelLayout,
} from "../../domain/sidePanelLayout.ts";
import { useTerminalSidePanelLayoutState } from "./useTerminalSidePanelLayoutState.ts";

type HookApi = ReturnType<typeof useTerminalSidePanelLayoutState>;
type HookOptions = Parameters<typeof useTerminalSidePanelLayoutState>[0];

const RESIZE_DEBOUNCE_MS = 300;

function renderLayoutHook(
  t: TestContext,
  options?: HookOptions,
): { api: () => HookApi; unmount: () => void } {
  const globals = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;
  const originalConsoleError = console.error;
  const errors: string[] = [];
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  console.error = (...args: unknown[]) => {
    const message = args.map(String).join(" ");
    if (message.includes("react-test-renderer is deprecated")) return;
    if (message.includes("DeprecationWarning")) return;
    errors.push(message);
  };

  let api: HookApi | null = null;
  function Host() {
    api = useTerminalSidePanelLayoutState(options);
    return null;
  }

  let renderer: ReactTestRenderer | null = null;
  act(() => {
    renderer = create(React.createElement(Host));
  });

  let unmounted = false;
  const unmount = () => {
    if (unmounted) return;
    unmounted = true;
    act(() => {
      renderer?.unmount();
    });
    console.error = originalConsoleError;
    globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    if (errors.length > 0) {
      assert.fail(`unexpected React errors: ${errors.join("\n")}`);
    }
  };

  t.after(() => unmount());
  return { api: () => api as HookApi, unmount };
}

test("user tool selection writes the committed layout through to the default preset", (t) => {
  const writes: Array<SidePanelLayout | null> = [];
  const { api } = renderLayoutHook(t, {
    onDefaultLayoutChange: (layout) => writes.push(layout),
  });

  act(() => {
    api().selectSidePanelToolForTab("tab-1", "sftp");
  });

  assert.equal(writes.length, 1);
  const panes = collectSidePanelPanes(writes[0]!.root);
  assert.equal(panes.length, 1);
  assert.equal(panes[0]!.tool, "sftp");
  assert.equal(getFocusedSidePanelPane(writes[0]!).tool, "sftp");
});

test("split, focus and pane close write through; closing the last pane clears the default", (t) => {
  const writes: Array<SidePanelLayout | null> = [];
  const { api } = renderLayoutHook(t, {
    onDefaultLayoutChange: (layout) => writes.push(layout),
  });
  const hook = api();

  act(() => {
    hook.selectSidePanelToolForTab("tab-1", "sftp");
  });
  assert.equal(writes.length, 1);

  act(() => {
    hook.splitPane("tab-1", "scripts", "horizontal", { paneId: "pane-b", splitId: "split-1" }, 800);
  });
  assert.equal(writes.length, 2);
  assert.deepEqual(
    collectSidePanelPanes(writes[1]!.root).map((pane) => pane.tool),
    ["sftp", "scripts"],
  );
  assert.equal(getFocusedSidePanelPane(writes[1]!).tool, "scripts");

  const sftpPane = collectSidePanelPanes(writes[1]!.root).find((pane) => pane.tool === "sftp")!;
  act(() => {
    hook.focusPane("tab-1", sftpPane.id);
  });
  assert.equal(writes.length, 3);
  assert.equal(getFocusedSidePanelPane(writes[2]!).id, sftpPane.id);

  // Closing one pane keeps the default updated with the reduced layout.
  act(() => {
    const closedWholePanel = hook.closePane("tab-1", "pane-b");
    assert.equal(closedWholePanel, false);
  });
  assert.equal(writes.length, 4);
  const reduced = collectSidePanelPanes(writes[3]!.root);
  assert.equal(reduced.length, 1);
  assert.equal(reduced[0]!.id, sftpPane.id);

  // Closing the final pane clears the saved default entirely.
  act(() => {
    const closedWholePanel = hook.closePane("tab-1", sftpPane.id);
    assert.equal(closedWholePanel, true);
  });
  assert.equal(writes.length, 5);
  assert.equal(writes[4], null);
});

test("structural updates supersede a pending resize write", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writes: Array<SidePanelLayout | null> = [];
  const { api } = renderLayoutHook(t, {
    onDefaultLayoutChange: (layout) => writes.push(layout),
  });
  const hook = api();

  act(() => {
    hook.selectSidePanelToolForTab("tab-1", "sftp");
  });
  act(() => {
    hook.splitPane("tab-1", "scripts", "horizontal", { paneId: "pane-b", splitId: "split-1" }, 800);
  });
  assert.equal(writes.length, 2);

  // Resize only schedules: nothing synchronous.
  act(() => {
    hook.resizeSplit("tab-1", "split-1", [300, 500]);
  });
  assert.equal(writes.length, 2);

  // A structural write supersedes the pending resize value immediately.
  act(() => {
    hook.selectSidePanelToolForTab("tab-1", "notes");
  });
  assert.equal(writes.length, 3);
  assert.deepEqual(
    collectSidePanelPanes(writes[2]!.root).map((pane) => pane.tool),
    ["sftp", "notes"],
  );

  await act(async () => t.mock.timers.tick(RESIZE_DEBOUNCE_MS + 100));
  assert.equal(writes.length, 3, "superseded resize timer must not fire");
});

test("debounced resize lands with the latest sizes once the timer fires", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writes: Array<SidePanelLayout | null> = [];
  const { api } = renderLayoutHook(t, {
    onDefaultLayoutChange: (layout) => writes.push(layout),
  });
  const hook = api();

  act(() => {
    hook.selectSidePanelToolForTab("tab-1", "sftp");
  });
  act(() => {
    hook.splitPane("tab-1", "scripts", "horizontal", { paneId: "pane-b", splitId: "split-1" }, 800);
  });
  act(() => {
    hook.resizeSplit("tab-1", "split-1", [250, 550]);
  });
  act(() => {
    hook.resizeSplit("tab-1", "split-1", [100, 700]);
  });
  assert.equal(writes.length, 2, "resize burst must not write synchronously");

  await act(async () => t.mock.timers.tick(RESIZE_DEBOUNCE_MS + 100));
  assert.equal(writes.length, 3);
  const splitNode = writes[2]!.root.type === "split" ? writes[2]!.root : null;
  assert.ok(splitNode);
  // Split sizes persist as normalized ratios: 100/800 and 700/800.
  assert.deepEqual(splitNode.sizes, [0.125, 0.875]);
});

test("pending resize write flushes on unmount", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writes: Array<SidePanelLayout | null> = [];
  const { api, unmount } = renderLayoutHook(t, {
    onDefaultLayoutChange: (layout) => writes.push(layout),
  });
  const hook = api();

  act(() => {
    hook.selectSidePanelToolForTab("tab-1", "sftp");
  });
  act(() => {
    hook.splitPane("tab-1", "scripts", "horizontal", { paneId: "pane-b", splitId: "split-1" }, 800);
  });
  act(() => {
    hook.resizeSplit("tab-1", "split-1", [400, 400]);
  });
  assert.equal(writes.length, 2);

  // Unmount before the debounce elapses: the pending write must flush.
  unmount();
  await act(async () => t.mock.timers.tick(RESIZE_DEBOUNCE_MS + 100));
  assert.equal(writes.length, 3);
  const splitNode = writes[2]!.root.type === "split" ? writes[2]!.root : null;
  assert.ok(splitNode);
  assert.deepEqual(splitNode.sizes, [0.5, 0.5]);
});

test("external open-tab writes (auto-open, preset application) never write through", (t) => {
  const writes: Array<SidePanelLayout | null> = [];
  const { api } = renderLayoutHook(t, {
    onDefaultLayoutChange: (layout) => writes.push(layout),
  });
  const hook = api();

  // Mirrors handleStatusChange auto-open and preset application: external
  // code writes the focused-tool map and the reconcile effect builds layouts.
  act(() => {
    hook.setSidePanelOpenTabs((previous) => {
      const next = new Map(previous);
      next.set("tab-1", "sftp");
      return next;
    });
  });

  assert.deepEqual(writes, [], "reconcile-driven layout creation must not persist a default");
});

test("hook works without a write-through callback (no options)", (t) => {
  const { api, unmount } = renderLayoutHook(t);
  act(() => {
    api().selectSidePanelToolForTab("tab-1", "scripts");
  });
  assert.ok(api().sidePanelLayoutsRef.current.get("tab-1"));
  unmount();
});
