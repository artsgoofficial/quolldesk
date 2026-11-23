import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';

import { useDatabaseWorkbenchState } from './useDatabaseWorkbenchState';
import type { Host, TerminalSession } from '../../domain/models';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// ——— fixtures ————————————————————————————————————————————————————————————

const makeHost = (): Host =>
  ({ id: 'h1', protocol: 'redis', hostname: '127.0.0.1', port: 6379, tags: [] }) as unknown as Host;

const makeSession = (id: string): TerminalSession =>
  ({ id, protocol: 'redis', autoConnect: false }) as unknown as TerminalSession;

type Deferred = { promise: Promise<{ connectionId: string }>; resolve: (c: { connectionId: string }) => void };

const deferredConnect = (): Deferred => {
  let resolve!: Deferred['resolve'];
  const promise = new Promise<{ connectionId: string }>((r) => { resolve = r; });
  return { promise, resolve };
};

// Flat quolldesk db bridge stub: connectRedis/disconnectRedis record every
// dial/hangup so tests can assert on the exact reconnect sequence.
const makeBridge = () => {
  const calls = { connect: 0, disconnect: [] as string[] };
  let deferred: Deferred | null = null;
  const bridge = {
    connectRedis: async () => {
      calls.connect += 1;
      if (deferred) return deferred.promise.then((c) => ({ ok: true, data: c }));
      return { ok: true, data: { connectionId: `c${calls.connect}` } };
    },
    disconnectRedis: async (connectionId: string) => {
      calls.disconnect.push(connectionId);
      return { ok: true, data: {} };
    },
    onDbConnectionClosed: () => () => undefined,
  };
  return { calls, bridge, armDeferred: () => { deferred = deferredConnect(); return deferred; } };
};

const withBridge = async (run: (env: {
  calls: ReturnType<typeof makeBridge>['calls'];
  bridge: ReturnType<typeof makeBridge>['bridge'];
  armDeferred: ReturnType<typeof makeBridge>['armDeferred'];
}) => Promise<void>) => {
  const { calls, bridge, armDeferred } = makeBridge();
  const globalAny = globalThis as Record<string, unknown>;
  const savedWindow = globalAny.window;
  globalAny.window = { quolldesk: bridge };
  try {
    await run({ calls, bridge, armDeferred });
  } finally {
    globalAny.window = savedWindow;
  }
};

type HookResult = ReturnType<typeof useDatabaseWorkbenchState>;

const mountHook = (sessionId: string) => {
  const result: { current: HookResult | null } = { current: null };
  function Probe() {
    result.current = useDatabaseWorkbenchState({
      session: makeSession(sessionId),
      host: makeHost(),
    });
    return null;
  }
  let renderer!: ReturnType<typeof create>;
  act(() => { renderer = create(React.createElement(Probe)); });
  const flush = async () => {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  return {
    result,
    flush,
    unmount() { act(() => renderer.unmount()); },
  };
};

// ——— reconnect semantics (top-tab 重新连接 routes here) ——————————————————

test('reconnect drops the live connection and dials a fresh one', async () => {
  await withBridge(async ({ calls }) => {
    const hook = mountHook('s-reconnect-connected');
    await act(async () => { hook.result.current!.connect(); await hook.flush(); });
    assert.equal(hook.result.current!.status, 'connected');
    assert.equal(hook.result.current!.connectionId, 'c1');

    await act(async () => { hook.result.current!.reconnect(); await hook.flush(); });
    assert.deepEqual(calls.disconnect, ['c1'], 'the live connection must be hung up before redialing');
    assert.equal(calls.connect, 2, 'reconnect must dial a fresh connection, not no-op on the live one');
    assert.equal(hook.result.current!.status, 'connected');
    assert.equal(hook.result.current!.connectionId, 'c2');
    hook.unmount();
  });
});

test('reconnect while connecting does not stack a second handshake', async () => {
  await withBridge(async ({ calls, armDeferred }) => {
    const deferred = armDeferred();
    const hook = mountHook('s-reconnect-connecting');
    await act(async () => { hook.result.current!.connect(); });
    assert.equal(hook.result.current!.status, 'connecting');

    await act(async () => { hook.result.current!.reconnect(); });
    assert.equal(calls.connect, 1, 'the in-flight handshake must stay the only dial');
    assert.deepEqual(calls.disconnect, [], 'no live connection exists mid-handshake to hang up');

    deferred.resolve({ connectionId: 'c-inflight' });
    await hook.flush();
    assert.equal(hook.result.current!.status, 'connected');
    assert.equal(hook.result.current!.connectionId, 'c-inflight');
    hook.unmount();
  });
});

test('reconnect from an errored state dials without a phantom hangup', async () => {
  await withBridge(async ({ calls, bridge }) => {
    const globalAny = globalThis as Record<string, unknown>;
    const failing = {
      connectRedis: async () => ({ ok: false, error: { code: 'ECONNREFUSED', message: 'refused' } }),
      disconnectRedis: async () => ({ ok: true, data: {} }),
      onDbConnectionClosed: () => () => undefined,
    };
    globalAny.window = { quolldesk: failing };
    const hook = mountHook('s-reconnect-error');
    await act(async () => { hook.result.current!.connect(); await hook.flush(); });
    assert.equal(hook.result.current!.status, 'error');

    // Swap the healthy bridge back in before retrying.
    globalAny.window = { quolldesk: { ...failing, connectRedis: bridge.connectRedis, disconnectRedis: bridge.disconnectRedis } };
    await act(async () => { hook.result.current!.reconnect(); await hook.flush(); });
    assert.equal(hook.result.current!.status, 'connected');
    assert.equal(hook.result.current!.connectionId, 'c1');
    assert.deepEqual(calls.disconnect, [], 'nothing was ever connected — reconnect must not hang up');
    hook.unmount();
  });
});
