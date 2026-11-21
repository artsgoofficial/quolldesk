import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Radix Dialog shells render nothing in renderToStaticMarkup (portal content
// mounts via effects), so UI-shell behavior is asserted on the source — the
// same pattern as components/host/HostTreeContextMenus.test.ts.
const source = readFileSync(new URL('./PromptDialog.tsx', import.meta.url), 'utf8');

test('PromptDialog resets to the initial value on every open', () => {
  assert.match(source, /if \(open\) setValue\(initialValue\)/);
});

test('PromptDialog never submits an empty or whitespace-only value', () => {
  assert.match(source, /const trimmed = value\.trim\(\)/);
  assert.match(source, /if \(busy \|\| !trimmed\) return/);
  assert.match(source, /disabled=\{busy \|\| !trimmed\}/);
});

test('PromptDialog submits on Enter and on the confirm button', () => {
  assert.match(source, /event\.key === 'Enter'/);
  assert.match(source, /onSubmit=\{\(event\) => \{\s*event\.preventDefault\(\);\s*submit\(\);\s*\}\}/);
  assert.match(source, /onClick=\{submit\}/);
});

test('PromptDialog supports the destructive confirm variant', () => {
  assert.match(source, /destructive \? "destructive" : "default"/);
});
