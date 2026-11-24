import { useCallback } from 'react';

import {
  getFocusedSidePanelPane,
  sidePanelToolAvailableForProtocol,
  type SidePanelLayout,
} from '../../domain/sidePanelLayout';
import {
  createWorkspaceLayoutPreset,
  rekeySidePanelLayout,
  withoutUnavailableSidePanelTools,
} from '../../domain/workspaceLayoutPreset';
import {
  clearWorkspaceLayoutPreset as clearStoredWorkspaceLayoutPreset,
  readWorkspaceLayoutPreset,
  writeWorkspaceLayoutPreset,
} from './workspaceLayoutPresetStore';

export type ResolvedWorkspaceLayoutPreset = {
  layout: SidePanelLayout;
  focusedTool: SidePanelTool;
  /** Connection protocol used for availability filtering (`session.protocol ?? 'ssh'`). */
  protocol: string;
};

/**
 * Application boundary for the saved default workspace side panel layout.
 * Owns the preset persistence lifecycle (read, validate, write) so UI
 * components consume handlers instead of touching the store directly.
 */
export function useWorkspaceLayoutPresetState() {
  /**
   * Resolve the saved default preset into a fresh layout for a newly
   * connected session. Panes the session cannot serve (SFTP/Browser on non-file
   * protocols) are pruned, and ids are rekeyed so several workspaces can
   * run the same preset in parallel. Returns null when there is no preset
   * or nothing survives availability filtering.
   */
  const resolveDefaultLayoutForSession = useCallback(
    (session: { protocol?: string | null }): ResolvedWorkspaceLayoutPreset | null => {
      const preset = readWorkspaceLayoutPreset();
      if (!preset) return null;

      const proto = session.protocol ?? 'ssh';
      const usable = withoutUnavailableSidePanelTools(
        preset.layout,
        (tool) => sidePanelToolAvailableForProtocol(tool, proto),
      );
      if (!usable) return null;

      const layout = rekeySidePanelLayout(usable, () => crypto.randomUUID());
      return { layout, focusedTool: getFocusedSidePanelPane(layout).tool, protocol: proto };
    },
    [],
  );

  /** Validate and persist a live layout as the default. False when invalid or the write failed. */
  const saveWorkspaceLayoutAsDefault = useCallback((layout: SidePanelLayout): boolean => {
    const preset = createWorkspaceLayoutPreset(layout);
    if (!preset) return false;
    return writeWorkspaceLayoutPreset(preset);
  }, []);

  /** Drop the saved default so newly connected sessions start without it. */
  const clearWorkspaceLayoutPreset = useCallback(() => {
    clearStoredWorkspaceLayoutPreset();
  }, []);

  return { resolveDefaultLayoutForSession, saveWorkspaceLayoutAsDefault, clearWorkspaceLayoutPreset };
}
