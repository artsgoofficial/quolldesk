import React, { useCallback, useSyncExternalStore } from 'react';
import { activeTabStore } from '../../application/state/activeTabStore';
import type { Workspace } from '../../types';
import {
  getTerminalPaneRenderSnapshot,
  parseTerminalPaneRenderSnapshot,
} from '../terminalPaneVisibility';

type WorkspaceRect = { x: number; y: number; w: number; h: number };

interface DatabasePaneSurfaceProps {
  sessionId: string;
  sessionWorkspaceId?: string;
  workspaceById: Map<string, Workspace>;
  workspaceRectsById: Map<string, Record<string, WorkspaceRect>>;
  isTerminalLayerVisible: boolean;
  children: React.ReactNode;
}

/**
 * Positioning + visibility shell for database workbench panes.
 *
 * DB sessions bypass TerminalPane (they render no xterm), but they still need
 * the same per-tab show/hide contract: only the pane of the active tab is
 * visible, everything else is hidden yet keeps rendering state — the workbench
 * owns the db connection lifecycle, so unmounting would disconnect it.
 * Visibility follows the exact same snapshot logic as TerminalPane.
 */
export const DatabasePaneSurface: React.FC<DatabasePaneSurfaceProps> = ({
  sessionId,
  sessionWorkspaceId,
  workspaceById,
  workspaceRectsById,
  isTerminalLayerVisible,
  children,
}) => {
  const getSnapshot = useCallback(
    () => getTerminalPaneRenderSnapshot({
      activeTabId: activeTabStore.getActiveTabId(),
      sessionId,
      sessionWorkspaceId,
      workspaceById,
      isTerminalLayerVisible,
    }),
    [sessionId, sessionWorkspaceId, workspaceById, isTerminalLayerVisible],
  );
  const snapshot = useSyncExternalStore(activeTabStore.subscribe, getSnapshot, getSnapshot);
  const { paneState } = parseTerminalPaneRenderSnapshot(snapshot);
  const isVisible = paneState.isVisible;

  // Split workspaces place panes by measured rect; solo/focus panes fill the
  // workspace area.
  const rect = isVisible && paneState.mode === 'split' && paneState.workspaceId
    ? workspaceRectsById.get(paneState.workspaceId)?.[sessionId] ?? null
    : null;
  const style: React.CSSProperties = rect
    ? {
      position: 'absolute',
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.w}px`,
      height: `${rect.h}px`,
      zIndex: 10,
    }
    : {
      position: 'absolute',
      inset: 0,
      zIndex: isVisible ? 10 : 0,
      // Hidden panes stay mounted for their connection state; visibility
      // (rather than display) keeps layout intact for the workbench DOM.
      visibility: isVisible ? 'visible' : 'hidden',
      pointerEvents: isVisible ? 'auto' : 'none',
    };

  return (
    <div
      data-session-id={sessionId}
      data-section="database-pane"
      data-visible={isVisible ? 'true' : 'false'}
      inert={!isVisible || undefined}
      style={style}
    >
      {children}
    </div>
  );
};
