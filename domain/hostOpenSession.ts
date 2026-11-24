import type { TerminalSession } from './models';
import { isDbProtocol } from './models/database';

export function findReusableHostSession(sessions: TerminalSession[], hostId: string) {
  if (!hostId) return undefined;
  // Auto-reconnect publishes connecting even during the retry delay. A plain
  // disconnected/restored tab needs user action and cannot satisfy host_open.
  const matches = sessions.filter((session) => (
    session.hostId === hostId
    && session.restoreState !== 'restored-disconnected'
    && (session.status === 'connected' || session.status === 'connecting')
  ));
  const picked = matches.find((session) => session.status === 'connected') ?? matches[0];
  return picked ? { sessionId: picked.id, connected: picked.status === 'connected' } : undefined;
}

/**
 * Database workbenches are one-per-host: a second connect (nav double-click)
 * must land on the existing tab instead of stacking a duplicate. Workspace
 * members focus through their own workspace flow and hiddenFromTabs sessions
 * are not user-visible tabs, so neither is a reuse candidate — status is
 * deliberately ignored (a dropped tab is still the tab, it just needs redial).
 */
export function findExistingDbSession(sessions: TerminalSession[], hostId: string) {
  if (!hostId) return undefined;
  return sessions.find((session) => (
    session.hostId === hostId
    && !session.workspaceId
    && !session.hiddenFromTabs
    && isDbProtocol(session.protocol)
  ));
}
