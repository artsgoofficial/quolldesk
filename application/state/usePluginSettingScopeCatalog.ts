import { useEffect, useState } from 'react';

import { quolldeskBridge } from '../../infrastructure/services/quolldeskBridge';

const EMPTY_SCOPE_CATALOG: QuollDeskPluginScopeCatalog = Object.freeze({
  workspace: Object.freeze([]),
  host: Object.freeze([]),
  session: Object.freeze([]),
  device: Object.freeze([{ id: 'device', label: 'This device' }]),
});

export function buildPluginSettingScopeCatalog({
  hosts,
  workspaces,
  sessions,
  deviceLabel,
}: {
  hosts: readonly { id: string; label?: string; hostname?: string }[];
  workspaces: readonly { id: string; title?: string }[];
  sessions: readonly { id: string; customName?: string; hostLabel?: string; hostname?: string }[];
  deviceLabel: string;
}): QuollDeskPluginScopeCatalog {
  return {
    host: hosts.map((host) => ({ id: host.id, label: host.label || host.hostname || host.id })),
    workspace: workspaces.map((workspace) => ({ id: workspace.id, label: workspace.title || workspace.id })),
    session: sessions.map((session) => ({
      id: session.id,
      label: session.customName || session.hostLabel || session.hostname || session.id,
    })),
    device: [{ id: 'device', label: deviceLabel }],
  };
}

export function resolvePluginSettingScopeSelection(
  catalog: QuollDeskPluginScopeCatalog,
  current: Partial<Record<QuollDeskPluginSettingScopeKind, string>>,
): Partial<Record<QuollDeskPluginSettingScopeKind, string>> {
  const next = { ...current };
  for (const kind of ['workspace', 'host', 'session', 'device'] as const) {
    const entries = catalog[kind];
    if (!entries.some((entry) => entry.id === current[kind])) next[kind] = entries[0]?.id;
  }
  return next;
}

export function usePluginSettingScopeCatalog(): QuollDeskPluginScopeCatalog {
  const [catalog, setCatalog] = useState<QuollDeskPluginScopeCatalog>(EMPTY_SCOPE_CATALOG);

  useEffect(() => {
    const bridge = quolldeskBridge.get();
    let cancelled = false;
    void bridge?.getPluginScopeCatalog?.().then((next) => {
      if (!cancelled) setCatalog(next);
    }).catch(() => {});
    const unsubscribe = bridge?.onPluginScopeCatalogChanged?.((next) => {
      if (!cancelled) setCatalog(next);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  return catalog;
}
