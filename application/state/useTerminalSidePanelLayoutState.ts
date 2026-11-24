import { useCallback, useEffect, useRef, useState } from 'react';

import {
  closeSidePanelPane,
  createSidePanelLayout,
  focusSidePanelPane,
  getFocusedSidePanelPane,
  resizeSidePanelSplit,
  selectSidePanelTool,
  splitSidePanelPane,
  type SidePanelLayout,
  type SidePanelSplitDirection,
  type SidePanelTool,
} from '../../domain/sidePanelLayout';

function replaceMapEntry<T>(previous: Map<string, T>, key: string, value: T): Map<string, T> {
  if (previous.get(key) === value) return previous;
  const next = new Map(previous);
  next.set(key, value);
  return next;
}

function deleteMapEntry<T>(previous: Map<string, T>, key: string): Map<string, T> {
  if (!previous.has(key)) return previous;
  const next = new Map(previous);
  next.delete(key);
  return next;
}

function entryMatches<T>(left: Map<string, T>, right: Map<string, T>, key: string): boolean {
  return left.has(key) === right.has(key) && left.get(key) === right.get(key);
}

/**
 * Keep a ref aligned with committed state without dropping a write React has
 * not rendered yet. An urgent update can rebase onto a transition: the
 * transition updater stores an intermediate map in the ref, and the later
 * updater changes only state. Copy committed entries the pending map did not
 * change, and follow committed once it moves past that pending value.
 */
function syncTrackedMap<T>(
  pending: Map<string, T>,
  lastRendered: Map<string, T>,
  committed: Map<string, T>,
): Map<string, T> {
  if (pending === lastRendered) return committed;
  if (pending === committed) return pending;

  let changed = false;
  const merged = new Map(pending);

  for (const key of committed.keys()) {
    if (entryMatches(pending, committed, key)) continue;
    const pendingMatchesRendered = entryMatches(pending, lastRendered, key);
    const committedMatchesRendered = entryMatches(committed, lastRendered, key);
    if (pendingMatchesRendered || !committedMatchesRendered) {
      merged.set(key, committed.get(key) as T);
      changed = true;
    }
  }

  for (const key of pending.keys()) {
    if (committed.has(key)) continue;
    if (entryMatches(pending, lastRendered, key)) {
      merged.delete(key);
      changed = true;
    }
  }

  return changed ? merged : pending;
}

function publishQueuedMap<T>(
  live: Map<string, T>,
  capturedBase: Map<string, T>,
  previous: Map<string, T>,
  stateNext: Map<string, T>,
  tabId: string,
  value: T | null,
): Map<string, T> {
  // The captured map is the synchronous write. Replaying it after an
  // intervening render drops entries that render already merged. When the ref
  // has moved ahead of this updater's base, reapply only this tab.
  if (live === capturedBase || live === previous) return stateNext;
  return value === null ? deleteMapEntry(live, tabId) : replaceMapEntry(live, tabId, value);
}

function reconcileSidePanelLayouts(
  layouts: Map<string, SidePanelLayout>,
  openTabs: Map<string, SidePanelTool>,
): Map<string, SidePanelLayout> | null {
  let changed = false;
  const next = new Map(layouts);

  for (const tabId of layouts.keys()) {
    if (!openTabs.has(tabId)) {
      next.delete(tabId);
      changed = true;
    }
  }

  for (const [tabId, tool] of openTabs) {
    const current = next.get(tabId);
    const updated = current
      ? selectSidePanelTool(current, tool)
      : createSidePanelLayout(tool, crypto.randomUUID());
    if (updated !== current) {
      next.set(tabId, updated);
      changed = true;
    }
  }

  return changed ? next : null;
}

const DEFAULT_LAYOUT_RESIZE_DEBOUNCE_MS = 300;

export type TerminalSidePanelLayoutStateOptions = {
  /**
   * Write-through for the device-default workspace layout. Called with the
   * committed layout after user-driven changes (tool select, split, focus,
   * pane close, split resize) or null when the user closed the whole panel.
   * Programmatic paths (preset application, auto-open reconciliation, tab
   * cleanup) never invoke it, so transient layouts cannot drift the default.
   */
  onDefaultLayoutChange?: (layout: SidePanelLayout | null) => void;
};

export function useTerminalSidePanelLayoutState(
  options: TerminalSidePanelLayoutStateOptions = {},
) {
  const onDefaultLayoutChangeRef = useRef(options.onDefaultLayoutChange);
  onDefaultLayoutChangeRef.current = options.onDefaultLayoutChange;
  const pendingDefaultLayoutRef = useRef<{ layout: SidePanelLayout } | null>(null);
  const defaultLayoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushPendingDefaultLayout = useCallback(() => {
    if (defaultLayoutTimerRef.current !== null) {
      clearTimeout(defaultLayoutTimerRef.current);
      defaultLayoutTimerRef.current = null;
    }
    const pending = pendingDefaultLayoutRef.current;
    pendingDefaultLayoutRef.current = null;
    if (pending) onDefaultLayoutChangeRef.current?.(pending.layout);
  }, []);

  // Flush a pending debounced resize write when the layer unmounts so the
  // last drag position is not lost to a quick app close.
  useEffect(() => flushPendingDefaultLayout, [flushPendingDefaultLayout]);

  const persistDefaultLayout = useCallback((layout: SidePanelLayout | null, debounce = false) => {
    if (!onDefaultLayoutChangeRef.current) return;
    // An immediate (structural) write always supersedes a scheduled resize
    // write: the committed layout already contains the pending sizes.
    if (defaultLayoutTimerRef.current !== null) {
      clearTimeout(defaultLayoutTimerRef.current);
      defaultLayoutTimerRef.current = null;
    }
    pendingDefaultLayoutRef.current = null;
    if (!debounce) {
      onDefaultLayoutChangeRef.current(layout);
      return;
    }
    pendingDefaultLayoutRef.current = { layout };
    defaultLayoutTimerRef.current = setTimeout(() => {
      defaultLayoutTimerRef.current = null;
      const pending = pendingDefaultLayoutRef.current;
      pendingDefaultLayoutRef.current = null;
      if (pending) onDefaultLayoutChangeRef.current?.(pending.layout);
    }, DEFAULT_LAYOUT_RESIZE_DEBOUNCE_MS);
  }, []);
  const [sidePanelOpenTabs, setSidePanelOpenTabs] = useState<Map<string, SidePanelTool>>(new Map());
  const [sidePanelLayouts, setSidePanelLayouts] = useState<Map<string, SidePanelLayout>>(new Map());
  const sidePanelOpenTabsRef = useRef(sidePanelOpenTabs);
  const sidePanelLayoutsRef = useRef(sidePanelLayouts);
  // Last maps this hook rendered. A transition can update the refs before React
  // commits them; an urgent render in between must not copy the stale state
  // back over that pending write. Once the queue commits, entries the pending
  // write did not touch still have to catch up, or the ref stays on the
  // transition updater's intermediate map.
  const renderedOpenTabsRef = useRef(sidePanelOpenTabs);
  const renderedLayoutsRef = useRef(sidePanelLayouts);
  sidePanelOpenTabsRef.current = syncTrackedMap(
    sidePanelOpenTabsRef.current,
    renderedOpenTabsRef.current,
    sidePanelOpenTabs,
  );
  renderedOpenTabsRef.current = sidePanelOpenTabs;
  sidePanelLayoutsRef.current = syncTrackedMap(
    sidePanelLayoutsRef.current,
    renderedLayoutsRef.current,
    sidePanelLayouts,
  );
  renderedLayoutsRef.current = sidePanelLayouts;

  // Legacy and external open paths write the focused-tool map. Reconcile that
  // public application boundary into the per-tab tree without disturbing the
  // other panes in an existing layout. Skip the setState when the click path
  // already stored this selection: scheduling an identical update still
  // renders again after a paired openTabs write.
  useEffect(() => {
    const base = sidePanelLayoutsRef.current;
    const reconciled = reconcileSidePanelLayouts(base, sidePanelOpenTabs);
    if (!reconciled) return;
    sidePanelLayoutsRef.current = reconciled;
    setSidePanelLayouts((previous) => {
      const next = previous === base
        ? reconciled
        : reconcileSidePanelLayouts(previous, sidePanelOpenTabs);
      if (!next) {
        sidePanelLayoutsRef.current = previous;
        return previous;
      }
      sidePanelLayoutsRef.current = next;
      return next;
    });
  }, [sidePanelOpenTabs]);

  const commitMap = useCallback((
    tabId: string,
    layout: SidePanelLayout,
    openTab: SidePanelTool | null,
  ) => {
    const layoutBase = sidePanelLayoutsRef.current;
    const openTabBase = sidePanelOpenTabsRef.current;
    const layouts = openTab === null
      ? deleteMapEntry(layoutBase, tabId)
      : replaceMapEntry(layoutBase, tabId, layout);
    const openTabs = openTab === null
      ? deleteMapEntry(openTabBase, tabId)
      : replaceMapEntry(openTabBase, tabId, openTab);
    sidePanelLayoutsRef.current = layouts;
    sidePanelOpenTabsRef.current = openTabs;
    setSidePanelLayouts((previous) => {
      const next = previous === layoutBase
        ? layouts
        : (openTab === null ? deleteMapEntry(previous, tabId) : replaceMapEntry(previous, tabId, layout));
      sidePanelLayoutsRef.current = publishQueuedMap(
        sidePanelLayoutsRef.current,
        layoutBase,
        previous,
        next,
        tabId,
        openTab === null ? null : layout,
      );
      return next;
    });
    setSidePanelOpenTabs((previous) => {
      const next = previous === openTabBase
        ? openTabs
        : (openTab === null ? deleteMapEntry(previous, tabId) : replaceMapEntry(previous, tabId, openTab));
      sidePanelOpenTabsRef.current = publishQueuedMap(
        sidePanelOpenTabsRef.current,
        openTabBase,
        previous,
        next,
        tabId,
        openTab,
      );
      return next;
    });
    // User-driven commit: write the layout through as the device default
    // (openTab === null means the user closed the whole panel).
    persistDefaultLayout(openTab === null ? null : layout);
  }, [persistDefaultLayout]);

  const commitLayout = useCallback((tabId: string, layout: SidePanelLayout) => {
    commitMap(tabId, layout, getFocusedSidePanelPane(layout).tool);
  }, [commitMap]);

  // Click path writes the focused tool and the layout together. The effect
  // above still reconciles external openTabs writes, and skips when
  // selectSidePanelTool returns the layout this call just stored.
  const selectSidePanelToolForTab = useCallback((tabId: string, tool: SidePanelTool) => {
    const current = sidePanelLayoutsRef.current.get(tabId);
    const updated = current
      ? selectSidePanelTool(current, tool)
      : createSidePanelLayout(tool, crypto.randomUUID());
    if (updated === current && sidePanelOpenTabsRef.current.get(tabId) === tool) return;
    commitLayout(tabId, updated);
  }, [commitLayout]);

  const focusPane = useCallback((tabId: string, paneId: string) => {
    const layout = sidePanelLayoutsRef.current.get(tabId);
    if (!layout) return;
    const nextLayout = focusSidePanelPane(layout, paneId);
    if (nextLayout !== layout) commitLayout(tabId, nextLayout);
  }, [commitLayout]);

  const splitPane = useCallback((
    tabId: string,
    tool: SidePanelTool,
    direction: SidePanelSplitDirection,
    ids: { paneId: string; splitId: string },
    availableAxisLength: number,
  ) => {
    const layout = sidePanelLayoutsRef.current.get(tabId);
    if (!layout) return;
    commitLayout(tabId, splitSidePanelPane(
      layout,
      layout.focusedPaneId,
      tool,
      direction,
      ids,
      availableAxisLength,
    ));
  }, [commitLayout]);

  const closePane = useCallback((tabId: string, paneId: string): boolean => {
    const layout = sidePanelLayoutsRef.current.get(tabId);
    if (!layout) return false;
    const nextLayout = closeSidePanelPane(layout, paneId);
    if (nextLayout) {
      commitLayout(tabId, nextLayout);
      return false;
    }

    commitMap(tabId, layout, null);
    return true;
  }, [commitLayout, commitMap]);

  const resizeSplit = useCallback((tabId: string, splitId: string, sizes: number[]) => {
    const layout = sidePanelLayoutsRef.current.get(tabId);
    if (!layout) return;
    const nextLayout = resizeSidePanelSplit(layout, splitId, sizes);
    if (nextLayout === layout) return;
    const base = sidePanelLayoutsRef.current;
    const layouts = replaceMapEntry(base, tabId, nextLayout);
    sidePanelLayoutsRef.current = layouts;
    setSidePanelLayouts((previous) => {
      const next = previous === base ? layouts : replaceMapEntry(previous, tabId, nextLayout);
      sidePanelLayoutsRef.current = next;
      return next;
    });
    // Drag fires per frame: coalesce the default-layout write behind a
    // trailing debounce instead of hitting storage on every update.
    persistDefaultLayout(nextLayout, true);
  }, [persistDefaultLayout]);

  return {
    sidePanelOpenTabs,
    setSidePanelOpenTabs,
    sidePanelOpenTabsRef,
    sidePanelLayouts,
    setSidePanelLayouts,
    sidePanelLayoutsRef,
    focusPane,
    splitPane,
    closePane,
    resizeSplit,
    selectSidePanelToolForTab,
  };
}
