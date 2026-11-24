import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Guards for what the startup bundle (index.html entry) may pull in. Each of
// these used to land in the entry chunk that every window parses at launch.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const staticImports = (source: string) =>
  [...source.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((match) => match[1]);

test('only the English dictionary is bundled with the startup entry', () => {
  const imports = staticImports(read('application/i18n/messages.ts'));
  assert.deepEqual(imports.filter((path) => path.startsWith('./locales/')), ['./locales/en']);
});

test('startup modules do not statically import the AI runtime or SDK providers', () => {
  const runtimeModules = /harness\/globalAgentRuntime|plugin\/trustedHostRuntime|plugin\/configuredModel|pluginAgent\/trustedAgentRuntime|sdk\/providers/;
  for (const path of [
    'application/state/aiStateSnapshots.ts',
    'application/state/usePluginAIContextHost.ts',
    'application/state/usePluginAgentHost.ts',
  ]) {
    const offending = staticImports(read(path)).filter((specifier) => runtimeModules.test(specifier));
    assert.deepEqual(offending, [], `${path} must load the AI runtime lazily`);
  }
});

test("Vite's preload helper stays out of the vendor-ai chunk", () => {
  // The entry imports the helper for its dynamic imports; if it is grouped
  // with the AI SDK, the whole vendor-ai chunk is preloaded at startup.
  assert.match(read('vite.config.ts'), /vite\/preload-helper'\)\) return 'preload-helper'/);
});

test('the QR decoder is loaded on demand', () => {
  assert.ok(!staticImports(read('components/HostTotpFields.tsx')).includes('jsqr'));
});

test('the splash screen shows the current quoll mark', () => {
  const html = read('index.html');
  assert.match(html, /splash-logo" src="\/icon\.svg"/);
  assert.ok(!html.includes('logo.svg'), 'splash must not reference the retired logo.svg');
  // The pre-rebrand artwork lingered in public/ after the icon overhaul; keep
  // it deleted so nothing can start referencing it again.
  assert.ok(!existsSync(join(root, 'public', 'logo.svg')), 'retired logo.svg must stay deleted');
  assert.ok(!existsSync(join(root, 'public', 'tray-iconTemplate.svg')), 'retired tray-iconTemplate.svg must stay deleted');
});
