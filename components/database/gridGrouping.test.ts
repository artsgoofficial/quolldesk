import assert from 'node:assert/strict';
import { test } from 'node:test';

import { groupStats } from './gridGrouping';

test('groupStats counts rows per key and sums finite numerics', () => {
  const rows = [
    { key: 'a', num: 1 },
    { key: 'a', num: '2.5' },
    { key: 'b', num: 10 },
    { key: 'a', num: 'nope' },
    { key: 'b', num: null },
    { key: null, num: 3 },
  ];
  const groups = groupStats(rows);
  assert.deepEqual(groups, [
    { value: 'a', count: 3, sum: 3.5 },
    { value: 'b', count: 2, sum: 10 },
    { value: 'NULL', count: 1, sum: 3 },
  ]);
});

test('non-numeric key columns yield counts with null sums', () => {
  const groups = groupStats([
    { key: 'x', num: 'text' },
    { key: 'x', num: null },
  ]);
  assert.deepEqual(groups, [{ value: 'x', count: 2, sum: null }]);
});

test('empty string keys fold into NULL bucket; sorted by count desc', () => {
  const groups = groupStats([
    { key: '', num: 1 },
    { key: 'rare', num: 2 },
    { key: 'a', num: 3 },
    { key: 'a', num: 4 },
    { key: 'a', num: 5 },
  ]);
  assert.deepEqual(groups.map((g) => g.value), ['a', 'NULL', 'rare']);
});
