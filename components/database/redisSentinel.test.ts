import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSentinelEntries } from './redisSentinel';

test('parseSentinelEntries flattens [k,v] pair entries', () => {
  const reply = [
    ['name', 'm1', 'ip', '10.0.0.1', 'port', '26379', 'flags', 'master', 'num-slaves', '2'],
    ['name', 'm2', 'ip', '10.0.0.2', 'port', '26379', 'flags', 'master,disconnected', 'num-slaves', '0'],
  ];
  const entries = parseSentinelEntries(reply);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    name: 'm1', ip: '10.0.0.1', port: '26379', flags: 'master', numSlaves: '2',
  });
  assert.equal(entries[1].flags, 'master,disconnected');
});

test('non-array replies yield an empty list (not-a-sentinel guard)', () => {
  assert.deepEqual(parseSentinelEntries('ERR unknown command'), []);
  assert.deepEqual(parseSentinelEntries(null), []);
  assert.deepEqual(parseSentinelEntries([42]), []);
});
