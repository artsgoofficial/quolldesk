import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { Workspace } from "../../domain/models/workspace.ts";

test("DatabasePaneSurface shows only the active tab's pane and keeps both mounted", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost", pretendToBeVisual: true,
  });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "localStorage"] as const) {
    install(key, key === "window" ? dom.window : dom.window[key]);
  }
  install("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
  install("requestAnimationFrame", dom.window.requestAnimationFrame.bind(dom.window));
  install("cancelAnimationFrame", dom.window.cancelAnimationFrame.bind(dom.window));
  install("IS_REACT_ACT_ENVIRONMENT", true);
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { activeTabStore } = await import("../../application/state/activeTabStore.ts");
  const { DatabasePaneSurface } = await import("./DatabasePaneSurface.tsx");

  const root = createRoot(dom.window.document.getElementById("root")!);
  const pane = (id: string) => dom.window.document.querySelector(`[data-session-id="${id}"]`);
  const paneState = (id: string) => ({
    visible: pane(id)?.getAttribute("data-visible") === "true",
    inert: pane(id)?.hasAttribute("inert"),
    mounted: !!pane(id),
  });
  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  const sharedProps: {
    isTerminalLayerVisible: boolean;
    workspaceById: Map<string, Workspace>;
    workspaceRectsById: Map<string, Record<string, { x: number; y: number; w: number; h: number }>>;
  } = {
    isTerminalLayerVisible: true,
    workspaceById: new Map(),
    workspaceRectsById: new Map(),
  };
  try {
    activeTabStore.setActiveTabId("db-a");
    await act(async () => {
      root.render(createElement("div", null,
        createElement(DatabasePaneSurface, { key: "a", sessionId: "db-a", children: createElement("div", null, "a"), ...sharedProps }),
        createElement(DatabasePaneSurface, { key: "b", sessionId: "db-b", children: createElement("div", null, "b"), ...sharedProps }),
      ));
    });
    await nextFrame();
    assert.deepEqual(paneState("db-a"), { visible: true, inert: false, mounted: true }, "active db pane must be visible");
    assert.deepEqual(paneState("db-b"), { visible: false, inert: true, mounted: true }, "inactive db pane must be hidden but stay mounted");

    // Switching the top tab moves visibility without unmounting (the db
    // connection lives in the workbench component state).
    activeTabStore.setActiveTabId("db-b");
    await nextFrame();
    await nextFrame();
    assert.deepEqual(paneState("db-b"), { visible: true, inert: false, mounted: true }, "newly active db pane must become visible");
    assert.deepEqual(paneState("db-a"), { visible: false, inert: true, mounted: true }, "previously active db pane must be hidden but stay mounted");
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test("DatabasePaneSurface lays out visible panes by split workspace rect", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost", pretendToBeVisual: true,
  });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "localStorage"] as const) {
    install(key, key === "window" ? dom.window : dom.window[key]);
  }
  install("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
  install("requestAnimationFrame", dom.window.requestAnimationFrame.bind(dom.window));
  install("cancelAnimationFrame", dom.window.cancelAnimationFrame.bind(dom.window));
  install("IS_REACT_ACT_ENVIRONMENT", true);
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { activeTabStore } = await import("../../application/state/activeTabStore.ts");
  const { DatabasePaneSurface } = await import("./DatabasePaneSurface.tsx");

  const root = createRoot(dom.window.document.getElementById("root")!);
  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const workspace: Workspace = {
    id: "w-1",
    title: "w",
    viewMode: "split",
    focusedSessionId: "db-a",
    focusSessionOrder: ["db-a", "db-b"],
    root: { id: "root-1", type: "pane", sessionId: "db-a" },
  };
  const sharedProps: {
    isTerminalLayerVisible: boolean;
    workspaceById: Map<string, Workspace>;
    workspaceRectsById: Map<string, Record<string, { x: number; y: number; w: number; h: number }>>;
  } = {
    isTerminalLayerVisible: true,
    workspaceById: new Map([["w-1", workspace]]),
    workspaceRectsById: new Map([
      ["w-1", {
        "db-a": { x: 0, y: 0, w: 320, h: 200 },
        "db-b": { x: 320, y: 0, w: 320, h: 200 },
      }],
    ]),
  };
  try {
    activeTabStore.setActiveTabId("w-1");
    await act(async () => {
      root.render(createElement("div", null,
        createElement(DatabasePaneSurface, { key: "a", sessionId: "db-a", sessionWorkspaceId: "w-1", children: createElement("div", null, "a"), ...sharedProps }),
        createElement(DatabasePaneSurface, { key: "b", sessionId: "db-b", sessionWorkspaceId: "w-1", children: createElement("div", null, "b"), ...sharedProps }),
      ));
    });
    await nextFrame();
    const paneA = dom.window.document.querySelector<HTMLElement>('[data-session-id="db-a"]')!;
    const paneB = dom.window.document.querySelector<HTMLElement>('[data-session-id="db-b"]')!;
    assert.equal(paneA.style.left, "0px");
    assert.equal(paneA.style.width, "320px");
    assert.equal(paneA.style.height, "200px");
    assert.equal(paneB.style.left, "320px");
    assert.equal(paneB.style.width, "320px");
    assert.equal(paneA.getAttribute("data-visible"), "true");
    assert.equal(paneB.getAttribute("data-visible"), "true");
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
