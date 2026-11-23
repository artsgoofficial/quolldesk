import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatBytes, parseMemoryUsageReply, parseScanReply, parseTypeReply, pickSample,
} from './redisBigKeys';

test('parseScanReply splits cursor and keys from the nested reply', () => {
  const r = parseScanReply(['8192', ['a', 'b', 'c']]);
  assert.deepEqual(r, { cursor: '8192', keys: ['a', 'b', 'c'] });
  assert.deepEqual(parseScanReply(null), { cursor: '0', keys: [] });
  assert.deepEqual(parseScanReply(['0', null]), { cursor: '0', keys: [] });
});

test('pickSample is evenly spaced and bounded', () => {
  const keys = Array.from({ length: 1000 }, (_, i) => `k${i}`);
  const sample = pickSample(keys, 100);
  assert.equal(sample.length, 100);
  assert.equal(sample[0], 'k0');
  assert.equal(sample[99], 'k990'); // floor(99 * 1000/100)
  // Under the cap → pass-through.
  assert.deepEqual(pickSample(['a', 'b'], 100), ['a', 'b']);
});

test('parseTypeReply and parseMemoryUsageReply tolerate odd shapes', () => {
  assert.equal(parseTypeReply('hash'), 'hash');
  assert.equal(parseTypeReply(null), 'none');
  assert.equal(parseMemoryUsageReply(4096), 4096);
  assert.equal(parseMemoryUsageReply(-1), 0);
  assert.equal(parseMemoryUsageReply('not-a-number'), 0);
});

test('formatBytes renders KB/MB/GB with one decimal', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3.00 GB');
});
