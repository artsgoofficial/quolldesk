import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { activeTabStore } from './activeTabStore';
import { terminalReconnectRegistry } from './terminalReconnectRegistry';
import { useSessionState } from './useSessionState';
import type { Host } from '../../domain/models';

function dbHost(): Host {
  return {
    id: 'db-host-1',
    label: 'Local Redis',
    hostname: '127.0.0.1',
    username: '',
    tags: [],
    os: 'linux',
    protocol: 'redis',
    port: 6379,
  };
}

function sshHost(): Host {
  return {
    id: 'ssh-host-1',
    label: 'Box',
    hostname: 'box.example.invalid',
    username: 'root',
    tags: [],
    os: 'linux',
    protocol: 'ssh',
  };
}

async function withSessionState(t: import('node:test').TestContext, run: (getState: () => ReturnType<typeof useSessionState>) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    CustomEvent: dom.window.CustomEvent,
    Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    // Reset while the JSDOM globals are still installed — the store notifies
    // via window.setTimeout and must not schedule after they are restored.
    activeTabStore.setActiveTabId('vault');
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  let state: ReturnType<typeof useSessionState>;
  function Probe() {
    state = useSessionState({ persistSessionRestore: false });
    return null;
  }
  await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Probe))));
  // The hook returns a fresh object per render — hand out a live reader, not
  // a snapshot, so post-act assertions observe committed state.
  await run(() => state!);
}

test('double-connecting a database host reuses the existing tab', async (t) => {
  await withSessionState(t, async (getState) => {
    const firstId = await act(async () => getState().connectToHost(dbHost()));
    assert.ok(firstId);
    assert.equal(getState().sessions.length, 1);

    const secondId = await act(async () => getState().connectToHost(dbHost()));
    assert.equal(secondId, firstId, 'the second double-click lands on the same tab');
    assert.equal(getState().sessions.length, 1, 'no duplicate workbench tab is stacked');
    assert.equal(activeTabStore.getActiveTabId(), firstId);
  });
});

test('a disconnected database tab is redialled through the reconnect registry', async (t) => {
  await withSessionState(t, async (getState) => {
    const sessionId = await act(async () => getState().connectToHost(dbHost()));
    let redials = 0;
    const unregister = terminalReconnectRegistry.register(sessionId!, () => { redials += 1; }, () => true);

    // Simulate the workbench reporting a dropped connection (same path the
    // tab status dot uses), then double-click the host again.
    await act(async () => getState().updateSessionStatus(sessionId!, 'disconnected'));
    await act(async () => getState().connectToHost(dbHost()));
    assert.equal(redials, 1, 'the dropped connection is redialled');
    assert.equal(getState().sessions.length, 1, 'reuse, not a duplicate tab');

    // A connected tab must not be redialled by a plain double-click.
    await act(async () => getState().updateSessionStatus(sessionId!, 'connected'));
    await act(async () => getState().connectToHost(dbHost()));
    assert.equal(redials, 1, 'a live connection is never hung up by reuse');
    unregister();
  });
});

test('terminal hosts keep opening one tab per connect', async (t) => {
  await withSessionState(t, async (getState) => {
    const firstId = await act(async () => getState().connectToHost(sshHost()));
    const secondId = await act(async () => getState().connectToHost(sshHost()));
    assert.notEqual(firstId, secondId);
    assert.equal(getState().sessions.length, 2);
  });
});

test('hidden database opens keep creating their own session', async (t) => {
  await withSessionState(t, async (getState) => {
    const firstId = await act(async () => getState().connectToHost(dbHost()));
    const hiddenId = await act(async () => getState().connectToHost(dbHost(), { hidden: true }));
    assert.notEqual(hiddenId, firstId);
    assert.equal(getState().sessions.length, 2);
    assert.equal(getState().sessions.find(s => s.id === hiddenId)?.hiddenFromTabs, true);
    assert.equal(activeTabStore.getActiveTabId(), firstId, 'hidden opens never steal focus');
  });
});

test('connectToHost stays wired to the dedup and redial path', () => {
  const source = readFileSync(new URL('./useSessionState.ts', import.meta.url), 'utf8');
  assert.match(source, /findExistingDbSession\(sessionsRef\.current/);
  assert.match(source, /terminalReconnectRegistry\.request\(existing\.id\)/);
  assert.match(source, /existing\.status === 'disconnected'/);
});
