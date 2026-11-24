/**
 * Renderer-side registry of the database connections that are currently open
 * in a workbench. `useDatabaseWorkbenchState` registers on connect and
 * unregisters on disconnect/unmount; the external-MCP session sync pushes the
 * list to the main process so AI/MCP database tools are scoped to open
 * connections only (spec §4.3). Main-process authority remains the connection
 * registry — this store mirrors what the renderer knows.
 */

import type { SqlEngineId } from '../../domain/models/dbEngines';

export type DatabaseAiConnectionInfo = {
  connectionId: string;
  /** Workbench tab session id (the AI panel's tab scope key). */
  sessionId?: string;
  dialect: 'redis' | SqlEngineId;
  hostname?: string | null;
  port?: number | null;
  /** Database name; a numeric logical db index for Redis. */
  database?: string | number | null;
  username?: string | null;
  label?: string;
};

type Listener = (connections: DatabaseAiConnectionInfo[]) => void;

const connectionsById = new Map<string, DatabaseAiConnectionInfo>();
const listeners = new Set<Listener>();

function snapshot(): DatabaseAiConnectionInfo[] {
  return Array.from(connectionsById.values());
}

function emit() {
  const current = snapshot();
  for (const listener of listeners) {
    try {
      listener(current);
    } catch {
      // A broken listener must not break registry bookkeeping.
    }
  }
}

export function registerDatabaseAiConnection(info: DatabaseAiConnectionInfo): void {
  if (!info?.connectionId) return;
  connectionsById.set(info.connectionId, { ...info });
  emit();
}

export function unregisterDatabaseAiConnection(connectionId: string): void {
  if (!connectionId || !connectionsById.has(connectionId)) return;
  connectionsById.delete(connectionId);
  emit();
}

export function listDatabaseAiConnections(): DatabaseAiConnectionInfo[] {
  return snapshot();
}

/** Resolve the open workbench connection registered for a tab session id. */
export function getDatabaseAiConnectionBySession(sessionId: string): DatabaseAiConnectionInfo | null {
  if (!sessionId) return null;
  for (const info of connectionsById.values()) {
    if (info.sessionId === sessionId) return info;
  }
  return null;
}

export function subscribeDatabaseAiConnections(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function _resetDatabaseAiScopeForTests(): void {
  connectionsById.clear();
  listeners.clear();
}
