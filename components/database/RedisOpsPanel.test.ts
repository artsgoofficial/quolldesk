import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clientListTextToRows, slowlogReplyToRows } from './RedisOpsPanel';

test('slowlogReplyToRows flattens the nested node-redis reply', () => {
  const reply = [
    [14, 1732300000, 1234, ['SLOWLOG', 'GET', '25']],
    [13, 1732299000, 88, ['GET', 'key']],
  ];
  const rows = slowlogReplyToRows(reply);
  assert.deepEqual(rows, [
    { id: '14', timestamp: '1732300000', micros: '1234', command: 'SLOWLOG GET 25' },
    { id: '13', timestamp: '1732299000', micros: '88', command: 'GET key' },
  ]);
});

test('slowlogReplyToRows tolerates stringified command parts and non-arrays', () => {
  assert.deepEqual(slowlogReplyToRows('nope'), []);
  const rows = slowlogReplyToRows([[1, 2, 3, 'GET key']]);
  assert.equal(rows[0].command, 'GET key');
  assert.deepEqual(slowlogReplyToRows([['only-id']]), [{ id: 'only-id', timestamp: '', micros: '', command: '' }]);
});

test('clientListTextToRows parses key=value pairs per line', () => {
  const text = [
    'id=12 addr=127.0.0.1:51000 name=worker db=0 age=100 cmd=client',
    'id=13 addr=127.0.0.1:51001 name=- db=2 age=5 cmd=get',
    '',
    'garbage line without pairs',
  ].join('\n');
  const rows = clientListTextToRows(text);
  assert.deepEqual(rows, [
    { id: '12', name: 'worker', addr: '127.0.0.1:51000', db: '0', age: '100', cmd: 'client' },
    { id: '13', name: '-', addr: '127.0.0.1:51001', db: '2', age: '5', cmd: 'get' },
  ]);
});
