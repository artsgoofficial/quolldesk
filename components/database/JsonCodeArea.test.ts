import assert from 'node:assert/strict';
import { test } from 'node:test';

import { highlightJson, tokenizeJson } from './JsonCodeArea';

test('tokenizeJson keeps object colons as their own tokens', () => {
  const tokens = tokenizeJson('{"name":"Nightly QA"}');
  const text = tokens.map((token) => token.text).join('');
  assert.equal(text, '{"name":"Nightly QA"}');
  const colon = tokens.find((token) => token.text === ':');
  assert.ok(colon, 'colon token exists');
  assert.equal(colon.kind, 'other');
  const key = tokens.find((token) => token.text === '"name"');
  assert.equal(key?.kind, 'key');
});

test('tokenizeJson classifies string values, numbers and keywords', () => {
  const tokens = tokenizeJson('{"n": 1, "ok": true, "s": "x"}');
  const kindOf = (text: string) => tokens.find((token) => token.text === text)?.kind;
  assert.equal(kindOf('"n"'), 'key');
  assert.equal(kindOf('1'), 'number');
  assert.equal(kindOf('true'), 'keyword');
  assert.equal(kindOf('"x"'), 'string');
});

test('tokenizeJson is punctuation-safe on arrays and nesting', () => {
  const text = '{"items":[1,2,{"deep":null}]}';
  assert.equal(tokenizeJson(text).map((token) => token.text).join(''), text);
});

test('highlightJson preserves the full text round-trip', () => {
  const text = '{"a": [true, 1.5e3, "b\\n"]}';
  const rendered = highlightJson(text).map((node) => node.props.children).join('');
  assert.equal(rendered, text);
});
