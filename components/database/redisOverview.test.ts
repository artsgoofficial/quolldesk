import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatDurationMs,
  parseKeyspace,
  redisHitRate,
  OPS_SAMPLE_CAPACITY,
  pushOpsSample,
  opsSparklinePoints,
} from './redisOverview';

test('parseKeyspace extracts keys, expires and avg TTL from the dbN INFO entry', () => {
  // INFO keyspace lines are "db0:keys=...,expires=...,avg_ttl=..." so the
  // flattened summary key is `db0` — NOT `keyspace.db0` (which never exists).
  const summary = { db0: 'keys=42,expires=7,avg_ttl=123456789' };
  assert.deepEqual(parseKeyspace(summary, 0), { keys: 42, expires: 7, avgTtlMs: 123456789 });
});

test('parseKeyspace returns null when the db has no keyspace entry', () => {
  assert.equal(parseKeyspace({ db1: 'keys=1,expires=0,avg_ttl=0' }, 0), null);
});

test('parseKeyspace tolerates malformed or partial entries', () => {
  assert.equal(parseKeyspace({ db0: 'garbage' }, 0), null);
  assert.equal(parseKeyspace({ db0: 'keys=abc,expires=0' }, 0), null);
  // avg_ttl missing entirely still parses the counts.
  assert.deepEqual(parseKeyspace({ db0: 'keys=3,expires=1' }, 0), { keys: 3, expires: 1, avgTtlMs: null });
});

test('redisHitRate computes hits / (hits + misses)', () => {
  assert.equal(redisHitRate({ keyspace_hits: '98', keyspace_misses: '2' }), 0.98);
});

test('redisHitRate is null with no traffic or missing counters', () => {
  assert.equal(redisHitRate({ keyspace_hits: '0', keyspace_misses: '0' }), null);
  assert.equal(redisHitRate({}), null);
  assert.equal(redisHitRate({ keyspace_hits: 'abc', keyspace_misses: '2' }), null);
});

test('formatDurationMs humanizes milliseconds across unit scales', () => {
  assert.equal(formatDurationMs(500), '500ms');
  assert.equal(formatDurationMs(59_000), '59s');
  assert.equal(formatDurationMs(90_000), '1m30s');
  assert.equal(formatDurationMs(3_600_000), '1h');
  assert.equal(formatDurationMs(90_000_000), '1d1h');
});

test('formatDurationMs returns null for absent or zero values', () => {
  assert.equal(formatDurationMs(0), null);
  assert.equal(formatDurationMs(null), null);
  assert.equal(formatDurationMs(Number.NaN), null);
});

test('pushOpsSample drops non-finite samples and caps the window', () => {
  assert.deepEqual(pushOpsSample([], null), []);
  assert.deepEqual(pushOpsSample([], Number.NaN), []);
  assert.deepEqual(pushOpsSample([], 12), [12]);
  let h: number[] = [];
  for (let i = 0; i < OPS_SAMPLE_CAPACITY + 5; i++) h = pushOpsSample(h, i);
  assert.equal(h.length, OPS_SAMPLE_CAPACITY);
  assert.equal(h[h.length - 1], OPS_SAMPLE_CAPACITY + 4);
});

test('opsSparklinePoints maps the newest sample to the right edge', () => {
  const flat = opsSparklinePoints([], 100, 24);
  assert.match(flat, /0,22 100,22/);
  const pts = opsSparklinePoints([0, 50, 100], 100, 24);
  const parts = pts.split(' ');
  assert.equal(parts.length, 3);
  // first point pinned left, last pinned right
  assert.ok(parts[0].startsWith('0,'));
  assert.ok(parts[2].startsWith('100,'));
  // peak is higher (smaller y) than valley
  const yValley = Number(parts[0].split(',')[1]);
  const yPeak = Number(parts[2].split(',')[1]);
  assert.ok(yPeak < yValley);
});
