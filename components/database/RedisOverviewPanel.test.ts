import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./RedisOverviewPanel.tsx', import.meta.url), 'utf8');

test('overview panel renders from the shared pure helpers, not ad-hoc parsing', () => {
  assert.match(source, /import \{[\s\S]{0,200}formatDurationMs[\s\S]{0,200}parseKeyspace[\s\S]{0,200}redisHitRate[\s\S]{0,200}\} from '\.\/redisOverview'/);
  assert.match(source, /parseKeyspace\(summary, db\)/);
  assert.match(source, /redisHitRate\(summary\)/);
});

test('all four cards use the db.redis.overview i18n keys', () => {
  assert.match(source, /db\.redis\.overview\.title/);
  assert.match(source, /db\.redis\.overview\.server/);
  assert.match(source, /db\.redis\.overview\.memory/);
  assert.match(source, /db\.redis\.overview\.keyspace/);
  assert.match(source, /db\.redis\.overview\.activity/);
});

test('missing INFO fields degrade to a dash instead of erroring', () => {
  assert.match(source, /const dash = /);
  assert.match(source, /dash\(/);
});

test('hit rate renders as a percentage with one decimal', () => {
  assert.match(source, /rate \* 100/);
  assert.match(source, /toFixed\(1\)/);
});

test('average TTL goes through the duration formatter', () => {
  assert.match(source, /formatDurationMs\(/);
});
