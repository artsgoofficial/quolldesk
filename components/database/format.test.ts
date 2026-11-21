import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatMaybeJson, formatReplyValue } from './format';

test('formatMaybeJson pretty-prints JSON objects and arrays', () => {
  const object = formatMaybeJson('{"b":1,"a":2}');
  assert.deepEqual(object, { isJson: true, formatted: '{\n  "b": 1,\n  "a": 2\n}' });

  const array = formatMaybeJson('[1,2,{"k":"v"}]');
  assert.equal(array.isJson, true);
  assert.equal(array.formatted, JSON.stringify([1, 2, { k: 'v' }], null, 2));
});

test('formatMaybeJson leaves non-JSON text untouched', () => {
  for (const text of ['hello', '42', '"quoted"', 'true', 'null', '{oops', '[1,2', '']) {
    assert.deepEqual(formatMaybeJson(text), { isJson: false, formatted: text }, text);
  }
});

test('formatMaybeJson keeps leading whitespace when text is not JSON', () => {
  assert.deepEqual(formatMaybeJson('  plain value  '), { isJson: false, formatted: '  plain value  ' });
});

test('formatMaybeJson detects JSON despite surrounding whitespace', () => {
  const result = formatMaybeJson('  {"x":1}  ');
  assert.equal(result.isJson, true);
  assert.equal(result.formatted, '{\n  "x": 1\n}');
});

test('formatMaybeJson passes through scalar JSON values unparsed', () => {
  assert.deepEqual(formatMaybeJson('  42  '), { isJson: false, formatted: '  42  ' });
  assert.deepEqual(formatMaybeJson('  "str"  '), { isJson: false, formatted: '  "str"  ' });
});

test('formatMaybeJson handles nullish input', () => {
  assert.deepEqual(formatMaybeJson(null), { isJson: false, formatted: '' });
  assert.deepEqual(formatMaybeJson(undefined), { isJson: false, formatted: '' });
});

test('formatReplyValue renders redis reply variants', () => {
  assert.equal(formatReplyValue(null), '(nil)');
  assert.equal(formatReplyValue(undefined), '(nil)');
  assert.equal(formatReplyValue('plain'), 'plain');
  assert.equal(formatReplyValue(''), '');
  assert.equal(formatReplyValue(42), '42');
  assert.equal(formatReplyValue(true), 'true');
  assert.equal(formatReplyValue(['a', 'b']), JSON.stringify(['a', 'b'], null, 2));
  assert.equal(formatReplyValue({ ok: 1 }), '{\n  "ok": 1\n}');
});

test('formatReplyValue falls back to String() when JSON.stringify throws', () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(formatReplyValue(circular), '[object Object]');
});
