import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { retainStableAiPanelContexts } from '../../domain/aiPanelContextsEqual';
import {
  buildAITerminalSessionInfo,
  type AIPanelContext,
} from '../../domain/buildAITerminalSessionInfo';
import { collectSessionIds } from '../../domain/workspace';
import { isDbProtocol } from '../../domain/models/database';
import type { TerminalContextReader } from '../../domain/terminalContextRead';
import { detectLocalOs } from '../../lib/localShell';
import type { Host, PortForwardingRule, TerminalSession, Workspace } from '../../types';
import {
  getDatabaseAiConnectionBySession,
  subscribeDatabaseAiConnections,
} from './databaseAiScopeStore';

interface UseTerminalAiContextsOptions {
  hosts: Host[];
  hostsRef: React.MutableRefObject<Host[]>;
  portForwardingRules: PortForwardingRule[];
  portForwardingRulesRef: React.MutableRefObject<PortForwardingRule[]>;
  mountedAiTabIds: string[];
  sessionHostsMap: Map<string, Host>;
  sessions: TerminalSession[];
  sessionsRef: React.MutableRefObject<TerminalSession[]>;
  terminalContextReadersRef: React.MutableRefObject<Map<string, TerminalContextReader>>;
  workspaces: Workspace[];
  workspacesRef: React.MutableRefObject<Workspace[]>;
}

export function useTerminalAiContexts({
  hosts,
  hostsRef,
  portForwardingRules,
  portForwardingRulesRef,
  mountedAiTabIds,
  sessionHostsMap,
  sessions,
  sessionsRef,
  terminalContextReadersRef,
  workspaces,
  workspacesRef,
}: UseTerminalAiContextsOptions) {
  const previousAiContextsRef = useRef<Map<string, AIPanelContext> | null>(null);

  // Database workbench connections register/unregister as tabs connect and
  // close; re-resolve the contexts when that happens so a db tab's native AI
  // panel binds to its live connectionId.
  const [dbConnectionsTick, setDbConnectionsTick] = useState(0);
  useEffect(() => subscribeDatabaseAiConnections(() => setDbConnectionsTick((value) => value + 1)), []);

  const aiContextsByTabId = useMemo(() => {
    void dbConnectionsTick;
    const localOs = detectLocalOs(navigator.userAgent || navigator.platform);
    const sessionById = new Map<string, TerminalSession>(sessions.map((session) => [session.id, session]));
    const workspaceById = new Map<string, Workspace>(workspaces.map((workspace) => [workspace.id, workspace]));
    const allHosts = hosts;
    const tabIds = new Set<string>(mountedAiTabIds);

    const contexts = new Map<string, AIPanelContext>();

    for (const tabId of tabIds) {
      const workspace = workspaceById.get(tabId);
      if (workspace) {
        const sessionIds = collectSessionIds(workspace.root);
        contexts.set(tabId, {
          scopeType: 'workspace',
          scopeTargetId: workspace.id,
          scopeHostIds: sessionIds
            .map((sessionId) => sessionById.get(sessionId)?.hostId)
            .filter((hostId): hostId is string => !!hostId),
          scopeLabel: workspace.title,
          focusedSessionId: workspace.focusedSessionId,
          terminalSessions: sessionIds.map((sessionId) =>
            buildAITerminalSessionInfo(
              sessionById.get(sessionId),
              sessionHostsMap.get(sessionId),
              localOs,
              { allHosts, portForwardingRules },
            ),
          ),
        });
        continue;
      }

      const session = sessionById.get(tabId);
      if (!session) continue;

      // Database workbench tab: bind the panel to the open connection
      // (targetId = connectionId; the db_* / redis_* tools are connection-gated).
      const tabHost = sessionHostsMap.get(session.id);
      if (isDbProtocol(tabHost?.protocol)) {
        const dbConnection = getDatabaseAiConnectionBySession(session.id);
        const descriptor = `${tabHost?.protocol}${dbConnection?.hostname ? ` · ${dbConnection.hostname}` : ''}${dbConnection?.database != null && dbConnection.database !== '' ? ` · ${dbConnection.database}` : ''}`;
        contexts.set(tabId, {
          scopeType: 'database',
          scopeTargetId: dbConnection?.connectionId,
          scopeHostIds: [],
          scopeLabel: session.hostLabel ? `${session.hostLabel} (${descriptor})` : descriptor,
          terminalSessions: [],
        });
        continue;
      }

      contexts.set(tabId, {
        scopeType: 'terminal',
        scopeTargetId: session.id,
        scopeHostIds: session.hostId ? [session.hostId] : [],
        scopeLabel: session.hostLabel ?? '',
        terminalSessions: [
          buildAITerminalSessionInfo(
            session,
            sessionHostsMap.get(session.id),
            localOs,
            { allHosts, portForwardingRules },
          ),
        ],
      });
    }

    const retained = retainStableAiPanelContexts(previousAiContextsRef.current, contexts);
    previousAiContextsRef.current = retained;
    return retained;
  }, [sessions, workspaces, mountedAiTabIds, sessionHostsMap, hosts, portForwardingRules, dbConnectionsTick]);

  const resolveAIExecutorContext = useCallback((scope: {
    type: 'terminal' | 'workspace' | 'database';
    targetId?: string;
    label?: string;
  }) => {
    const latestWorkspaces = workspacesRef.current;
    const latestSessions = sessionsRef.current;
    const latestHosts = hostsRef.current;
    const localOs = detectLocalOs(navigator.userAgent || navigator.platform);
    const sessionIds = scope.type === 'workspace'
      ? (() => {
          const workspace = scope.targetId ? latestWorkspaces.find((w) => w.id === scope.targetId) : undefined;
          return workspace?.root ? collectSessionIds(workspace.root) : [];
        })()
      : scope.type === 'database'
        ? [] // database chats carry no terminal sessions in scope
        : scope.targetId ? [scope.targetId] : [];

    const workspaceName = scope.type === 'workspace'
      ? latestWorkspaces.find((w) => w.id === scope.targetId)?.title ?? scope.label
      : undefined;

    return {
      sessions: sessionIds.map((sid) => {
        const session = latestSessions.find((s) => s.id === sid);
        const host = session ? sessionHostsMap.get(session.id) : undefined;
        return buildAITerminalSessionInfo(session, host, localOs, {
          allHosts: latestHosts,
          portForwardingRules: portForwardingRulesRef.current,
        });
      }),
      workspaceId: scope.type === 'workspace' ? scope.targetId : undefined,
      workspaceName,
      readTerminalContext: (request: Parameters<TerminalContextReader>[0]) => {
        const reader = terminalContextReadersRef.current.get(request.sessionId);
        if (!reader) {
          return Promise.resolve({
            ok: false as const,
            error: `Terminal session "${request.sessionId}" has no readable terminal buffer.`,
          });
        }
        return reader(request);
      },
    };
  }, [hostsRef, portForwardingRulesRef, sessionHostsMap, sessionsRef, terminalContextReadersRef, workspacesRef]);

  return {
    aiContextsByTabId,
    resolveAIExecutorContext,
  };
}
