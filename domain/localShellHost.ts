import type { Host } from './models';

/**
 * Vault-side "local shell" (CMD / PowerShell / WSL / custom shell) host entry.
 *
 * A vault host with protocol 'local' is grouped, sorted and connected exactly
 * like any other saved host: clicking it opens a terminal session whose boot
 * path resolves the host's stored shell (see `startLocal` in
 * `createTerminalSessionStarters` and the bridge resolution of discovered
 * shell ids).
 */

export type LocalShellHostOs = 'linux' | 'windows' | 'macos';

export interface LocalShellHostInput {
  id?: string;
  os?: LocalShellHostOs;
  label?: string;
  /** Discovered shell id (e.g. "wsl-ubuntu") or a custom shell path/command. Empty = system default. */
  shell?: string;
  shellArgs?: string[];
  shellName?: string;
  shellIcon?: string;
  startDir?: string;
  group?: string;
  tags?: string[];
  notes?: string;
}

export const LOCAL_SHELL_HOST_TAG = 'local';

export const createLocalShellHost = (input: LocalShellHostInput): Host => ({
  id: input.id ?? `local-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
  label: input.label?.trim() || input.shellName?.trim() || 'Local Shell',
  hostname: 'localhost',
  username: '',
  tags: input.tags ?? [LOCAL_SHELL_HOST_TAG],
  group: input.group?.trim() || '',
  os: input.os ?? 'linux',
  protocol: 'local',
  createdAt: Date.now(),
  notes: input.notes?.trim() || undefined,
  localShell: input.shell?.trim() || undefined,
  localShellArgs: input.shellArgs?.length ? input.shellArgs : undefined,
  localShellName: input.shellName?.trim() || undefined,
  localShellIcon: input.shellIcon?.trim() || undefined,
  localStartDir: input.startDir?.trim() || undefined,
});

/** What an existing vault host shows as its local-shell display name. */
export const getLocalShellHostSubtitle = (
  host: Pick<Host, 'protocol' | 'localShellName'>,
  fallback = 'Local Shell',
): string => host.localShellName?.trim() || fallback;

export interface VaultHostRowSubtitleOptions {
  /** Translated fallback shown for default-shell local hosts. */
  localFallback?: string;
}

/** Row subtitle shared by the vault tree rows and host cards. */
export const getVaultHostRowSubtitle = (
  host: Pick<Host, 'protocol' | 'localShellName' | 'username' | 'hostname' | 'port' | 'label' | 'tags'>,
  options?: VaultHostRowSubtitleOptions,
): string => {
  if (host.protocol === 'local') {
    return getLocalShellHostSubtitle(host, options?.localFallback);
  }
  const username = (host.username ?? '').trim();
  const hostname = (host.hostname ?? '').trim();
  const port = typeof host.port === 'number' && Number.isFinite(host.port) && host.port > 0 && host.port !== 22
    ? `:${host.port}`
    : '';
  if (!hostname) return username;
  if (username) return `${username}@${hostname}${port}`;
  // Unnamed host (label is the address): repeating the address as the subtitle
  // duplicates the card title, so prefer tags, then a non-default port, then
  // nothing — blank reads better than "1.2.3.4" under a "1.2.3.4" title.
  const label = (host.label ?? '').trim();
  if (hostname === label) {
    const tags = (host.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
    if (tags.length > 0) return tags.join(' · ');
    if (port) return `${hostname}${port}`;
    return '';
  }
  return hostname;
};

export interface ResolveDefaultLocalShellContext {
  discoveredShells?: DiscoveredShell[];
  terminalSettings?: { localShell?: string; localShellArgs?: string[]; localStartDir?: string };
  resolveShellSetting?: (
    localShell: string,
    discoveredShells: DiscoveredShell[],
    customArgs?: string[],
  ) => { command: string; args?: string[] } | null;
}

/** Resolve launch settings before a local session snapshots them. */
export const resolveHostDefaultLocalShell = (
  host: Host,
  ctx: ResolveDefaultLocalShellContext,
): Host => {
  if (host.protocol !== 'local') return host;
  const configuredShell = host.localShell || ctx.terminalSettings?.localShell || '';
  const customArgs = host.localShell
    ? host.localShellArgs
    : configuredShell ? ctx.terminalSettings?.localShellArgs : undefined;
  const resolved = ctx.resolveShellSetting?.(
    configuredShell, ctx.discoveredShells ?? [], customArgs,
  );
  const matchedShell = ctx.discoveredShells?.find((shell) => shell.id === configuredShell);
  return {
    ...host,
    // Empty means the backend default, not a later Vault/Settings value.
    localShell: resolved?.command || configuredShell || '',
    localShellArgs: resolved?.args ?? customArgs,
    localShellName: host.localShell ? host.localShellName : matchedShell?.name,
    localShellIcon: host.localShell ? host.localShellIcon : matchedShell?.icon,
    // The existing launcher expands ~ to home. Capture it explicitly when
    // neither host nor Settings supplies a directory, so a later global edit
    // cannot change a copied session's original launch directory.
    localStartDir: host.localStartDir || ctx.terminalSettings?.localStartDir || '~',
  };
};
