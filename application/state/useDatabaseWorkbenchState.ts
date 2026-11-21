import { useCallback, useEffect, useRef, useState } from 'react';
import type { Host, TerminalSession } from '../../domain/models';
import { isDbProtocol } from '../../domain/models/database';
// application/state may import infrastructure services directly (the
// no-restricted-imports rule only binds components/**).
import {
  databaseClient,
  dbErrorMessage,
  onDbConnectionClosed,
  resolveDbConnectArgs,
} from '@/infrastructure/services/databaseClient';
import { registerDatabaseAiConnection, unregisterDatabaseAiConnection } from './databaseAiScopeStore';

export type WorkbenchStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'disconnected';

export function useDatabaseWorkbenchState(params: {
  session: TerminalSession;
  host: Host;
  hosts?: Host[];
  /** Fires only when the MAIN PROCESS closed the connection (idle reap / driver death) — not on manual disconnect. */
  onConnectionLost?: () => void;
}) {
  const { session, host, hosts } = params;
  const dialect = isDbProtocol(host.protocol) ? host.protocol : 'postgresql';
  const [status, setStatus] = useState<WorkbenchStatus>('idle');
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const connectingRef = useRef(false);
  // Live mirror of connectionId so the unmount cleanup does not depend on
  // effect timing (the state setter from a manual disconnect must already be
  // visible to cleanup, otherwise the same connection is closed twice).
  const connectionIdRef = useRef<string | null>(null);
  // Cancelled flag for the in-flight connect: when the component unmounts
  // mid-handshake the resolved connection is an orphan and must be closed.
  const connectCancelledRef = useRef(false);
  // onConnectionLost in a ref so the push subscription stays mounted across
  // renders (an inline arrow prop would otherwise resubscribe every render).
  const onConnectionLostRef = useRef(params.onConnectionLost);
  useEffect(() => {
    onConnectionLostRef.current = params.onConnectionLost;
  });

  const connect = useCallback(() => {
    if (connectingRef.current || connectionIdRef.current) return;
    connectingRef.current = true;
    connectCancelledRef.current = false;
    setStatus('connecting');
    setErrorMessage(null);
    (async () => {
      try {
        const dbConfig = dialect === 'redis' ? host.redisConfig : host.sqlConfig;
        let tunnelHost: Host | undefined;
        if (dbConfig?.tunnelHostId && hosts) {
          tunnelHost = hosts.find((h) => h.id === dbConfig.tunnelHostId);
        }
        const args = resolveDbConnectArgs({ host, dialect, tunnelHost });
        const result = await databaseClient[dialect].connect(args);
        if (connectCancelledRef.current) {
          // Unmounted while connecting: close the orphaned connection.
          void databaseClient[dialect].disconnect(result.connectionId).catch(() => undefined);
          return;
        }
        connectionIdRef.current = result.connectionId;
        setConnectionId(result.connectionId);
        setStatus('connected');
        // Mirror into the AI/MCP scope store so database tools only ever
        // target connections that are currently open (spec §3.3/§4.3), and
        // so the tab's native AI panel can bind to this connection.
        registerDatabaseAiConnection({
          connectionId: result.connectionId,
          sessionId: session.id,
          dialect,
          hostname: host.hostname,
          port: typeof host.port === 'number' ? host.port : (host.port ? Number(host.port) || null : null),
          database: (dialect === 'redis' ? host.redisConfig?.redisDb : host.sqlConfig?.database) ?? null,
          username: host.username,
          label: host.label,
        });
      } catch (err) {
        if (connectCancelledRef.current) return;
        setStatus('error');
        setErrorMessage(dbErrorMessage(err));
      } finally {
        connectingRef.current = false;
      }
    })();
  }, [dialect, host, hosts, session.id]);

  const disconnect = useCallback(() => {
    // Manual disconnect also cancels an in-flight connect: a handshake that
    // resolves afterwards is an orphan and must be discarded (same semantics
    // as the unmount cleanup below).
    connectCancelledRef.current = true;
    if (connectionIdRef.current) {
      void databaseClient[dialect].disconnect(connectionIdRef.current).catch(() => undefined);
      unregisterDatabaseAiConnection(connectionIdRef.current);
    }
    connectionIdRef.current = null;
    setConnectionId(null);
    setStatus('disconnected');
  }, [dialect]);

  // autoConnect fires only on mount while idle (initial status is idle).
  useEffect(() => {
    if (session.autoConnect && status === 'idle') {
      // StrictMode dev double-mount: the first invocation's handshake is
      // still in flight and was flagged cancelled by the simulated unmount.
      // Re-adopt it here so the resolving handshake is kept, not orphaned
      // (otherwise the second autoConnect attempt is blocked by
      // connectingRef and the status would stay 'connecting' forever).
      connectCancelledRef.current = false;
      connect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Unmount: disconnect exactly once (skipped when already disconnected
  // manually; in-flight connects discard + close their orphaned result).
  useEffect(() => {
    return () => {
      connectCancelledRef.current = true;
      if (connectionIdRef.current) {
        void databaseClient[dialect].disconnect(connectionIdRef.current).catch(() => undefined);
        unregisterDatabaseAiConnection(connectionIdRef.current);
        connectionIdRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Main-process closes (registry idle reap, driver death) otherwise leave
  // this tab green over a dead connection: every op then fails with
  // NOT_CONNECTED while the header still reads 已连接. Flip to 'disconnected'
  // on the push so the dot, label and reconnect button stay truthful.
  // Best-effort subscribe: bridgeless environments (unit tests) throw.
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = onDbConnectionClosed((payload) => {
        if (payload?.connectionId !== connectionIdRef.current) return;
        connectionIdRef.current = null;
        setConnectionId(null);
        unregisterDatabaseAiConnection(payload.connectionId);
        setStatus('disconnected');
        onConnectionLostRef.current?.();
      });
    } catch {
      return; // no bridge (tests): nothing to sync
    }
    return () => { unsubscribe?.(); };
  }, []);

  return { status, connectionId, errorMessage, connect, disconnect, dialect };
}
