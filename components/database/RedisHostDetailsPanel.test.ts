import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./RedisHostDetailsPanel.tsx', import.meta.url), 'utf8');

test('the logical-db field validates against the shared 0..65535 range, not a hardcoded 15', () => {
  // Redis `databases` is server config (16 is only the default): the form must
  // accept db16+ and share the exact range with the domain sanitizer.
  assert.match(source, /isValidRedisDbIndex/);
  assert.ok(!/Number\(redisDb\) > 15/.test(source), 'the old hardcoded cap must be gone');
});
