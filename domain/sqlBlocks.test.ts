import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractSqlBlocks } from './sqlBlocks';

test('extracts sql-fenced blocks', () => {
  assert.deepEqual(extractSqlBlocks('Here:\n```sql\nSELECT 1;\n```\ndone'), ['SELECT 1;']);
  assert.deepEqual(extractSqlBlocks('```SQL\nselect 2\n```'), ['select 2']);
  assert.deepEqual(extractSqlBlocks('```mysql\nSHOW TABLES\n```'), ['SHOW TABLES']);
  assert.deepEqual(extractSqlBlocks('```postgresql\nSELECT 3\n```'), ['SELECT 3']);
});

test('ignores non-sql fences', () => {
  assert.deepEqual(extractSqlBlocks('```js\nSELECT 1\n```'), []);
  assert.deepEqual(extractSqlBlocks('plain text'), []);
  assert.deepEqual(extractSqlBlocks('```\nSELECT 1\n```'), []); // untagged fence
});

test('handles multiple blocks and unterminated fences', () => {
  assert.deepEqual(
    extractSqlBlocks('```sql\nSELECT a\n```\ntext\n```pgsql\nSELECT b\n```'),
    ['SELECT a', 'SELECT b'],
  );
  assert.deepEqual(extractSqlBlocks('```sql\nSELECT unterminated'), ['SELECT unterminated']);
  assert.deepEqual(extractSqlBlocks('```sql\n\n```'), []); // empty body skipped
});
