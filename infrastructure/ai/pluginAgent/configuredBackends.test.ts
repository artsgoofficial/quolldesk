import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfiguredPluginAgentBackends, getConfiguredQuollAgentModel, prepareConfiguredQuollAgentModel } from './configuredBackends';
import * as keys from '../../config/storageKeys';

const config = { id: 'synthetic', name: 'Synthetic', providerId: 'custom' as const, enabled: true, defaultModel: 'fixture', apiKey: 'FIXTURE_ONLY_MARKER' };
test('Quoll backend follows existing Agent overrides and syncs host configuration without opening the sidebar', async (t) => {
  const values = new Map<string, string>(); const old = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'); const windowOld = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null } });
  const providers = [config, { ...config, id: 'override', name: 'Override', defaultModel: 'override-default' }];
  values.set(keys.STORAGE_KEY_AI_PROVIDERS, JSON.stringify(providers)); values.set(keys.STORAGE_KEY_AI_ACTIVE_PROVIDER, config.id);
  values.set(keys.STORAGE_KEY_AI_ACTIVE_MODEL, 'active-only');
  values.set(keys.STORAGE_KEY_AI_AGENT_PROVIDER_MAP, JSON.stringify({ quoll: 'override' }));
  values.set(keys.STORAGE_KEY_AI_AGENT_MODEL_MAP, JSON.stringify({ quoll: 'agent-specific' }));
  let syncs = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { quolldesk: { aiSyncProviders: async (items: unknown[]) => {
    assert.deepEqual(items, providers); syncs++; return { ok: true };
  } } } });
  t.after(() => { for (const [key, descriptor] of [['localStorage', old], ['window', windowOld]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  } });
  const selected = getConfiguredQuollAgentModel()!; assert.equal(selected.config.id, 'override'); assert.equal(selected.config.defaultModel, 'agent-specific');
  await prepareConfiguredQuollAgentModel(selected.revision); assert.equal(syncs, 1);
  values.set(keys.STORAGE_KEY_AI_AGENT_MODEL_MAP, JSON.stringify({ quoll: 'changed' })); await assert.rejects(prepareConfiguredQuollAgentModel(selected.revision));
  assert.equal(syncs, 1);
});

test('backend refs isolate runtimes, expire with controlled time and invalidate native/model configuration changes', () => {
  let time = 1; let revision = '1'; let externalModel = 'synthetic-native-model';
  const external = { id: 'claude-local', name: 'Claude synthetic', command: '/synthetic/claude', enabled: true, available: true, sdkBackend: 'claude', env: { PRIVATE: 'PRIVATE_ENV' } };
  const backends = new ConfiguredPluginAgentBackends({ getModel: () => ({ config, label: 'Synthetic', revision }),
    prepareModel: async () => {}, getExternal: () => [external, { ...external, id: 'codex', sdkBackend: 'codex' }],
    getExternalModel: () => externalModel, clock: () => time });
  const rows = backends.list('r1'); const quoll = rows.find((item) => item.backend === 'quoll')!; const claude = rows.find((item) => item.backend === 'claude')!;
  assert.doesNotMatch(JSON.stringify(rows), /FIXTURE_ONLY_MARKER|PRIVATE_ENV|apiKey|command|env|claude-local|synthetic-native-model/);
  assert.equal(rows.find((item) => item.backend === 'codex')?.status, 'unsupported');
  assert.equal(backends.resolve(claude.hostHandle, 'r1').selectedModel, externalModel);
  assert.throws(() => backends.resolve(quoll.hostHandle, 'r2'));
  revision = '2'; assert.throws(() => backends.resolve(quoll.hostHandle, 'r1'));
  externalModel = 'changed'; assert.throws(() => backends.resolve(claude.hostHandle, 'r1'));
  const next = backends.list('r1').find((item) => item.backend === 'quoll')!;
  time += 300_001; assert.throws(() => backends.resolve(next.hostHandle, 'r1'));
  const refreshed = backends.list('r1').find((item) => item.backend === 'quoll')!; assert.notEqual(refreshed.hostHandle, next.hostHandle);
  backends.releaseRuntime('r1'); assert.throws(() => backends.resolve(refreshed.hostHandle, 'r1')); backends.shutdown();
});
