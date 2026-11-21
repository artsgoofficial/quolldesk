import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatDurationMs, parseKeyspace, redisHitRate } from './redisOverview';

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
