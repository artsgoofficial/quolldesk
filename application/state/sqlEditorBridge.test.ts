import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  emitSqlEditorAction,
  subscribeSqlEditorAction,
  emitAiPrompt,
  subscribeAiPrompt,
  requestAiPanelOpen,
  subscribeAiPanelOpenRequests,
  _resetSqlEditorBridgeForTests,
} from './sqlEditorBridge';

test('emitSqlEditorAction delivers to all listeners with monotonic seq', () => {
  _resetSqlEditorBridgeForTests();
  const seen: Array<{ kind: string; sql: string; seq: number }> = [];
  const stop1 = subscribeSqlEditorAction((action) => seen.push({ kind: action.kind, sql: action.sql, seq: action.seq }));
  const stop2 = subscribeSqlEditorAction((action) => seen.push({ kind: action.kind, sql: action.sql, seq: action.seq }));
  emitSqlEditorAction({ kind: 'insert', sql: 'SELECT 1' });
  emitSqlEditorAction({ kind: 'replace', sql: 'SELECT 2', connectionId: 'c1' });
  assert.equal(seen.length, 4);
  assert.deepEqual(seen[0], { kind: 'insert', sql: 'SELECT 1', seq: 1 });
  assert.deepEqual(seen[1], { kind: 'insert', sql: 'SELECT 1', seq: 1 });
  assert.equal(seen[2].seq, 2);
  assert.equal(seen[3].seq, 2);
  stop1();
  stop2();
});

test('sql editor unsubscribe stops delivery; throwing listener isolated', () => {
  _resetSqlEditorBridgeForTests();
  const seen: string[] = [];
  const stop = subscribeSqlEditorAction((action) => seen.push(action.sql));
  subscribeSqlEditorAction(() => { throw new Error('boom'); });
  emitSqlEditorAction({ kind: 'insert', sql: 'SELECT 1' });
  assert.deepEqual(seen, ['SELECT 1']);
  stop();
  emitSqlEditorAction({ kind: 'insert', sql: 'SELECT 2' });
  assert.deepEqual(seen, ['SELECT 1']);
});

test('emitAiPrompt carries text+connectionId with monotonic seq', () => {
  _resetSqlEditorBridgeForTests();
  const seen: Array<{ text: string; connectionId?: string; seq: number }> = [];
  const stop = subscribeAiPrompt((payload) => seen.push(payload));
  const first = emitAiPrompt({ text: 'optimize this', connectionId: 'conn-1' });
  const second = emitAiPrompt({ text: 'fix this' });
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.deepEqual(seen, [
    { text: 'optimize this', connectionId: 'conn-1', seq: 1 },
    { text: 'fix this', seq: 2 }, // connectionId omitted when not provided
  ]);
  stop();
  emitAiPrompt({ text: 'nobody hears this' });
  assert.equal(seen.length, 2);
});

test('requestAiPanelOpen broadcasts sessionId with monotonic seq', () => {
  _resetSqlEditorBridgeForTests();
  const seen: Array<{ sessionId: string; seq: number }> = [];
  const stop = subscribeAiPanelOpenRequests((request) => seen.push(request));
  requestAiPanelOpen({ sessionId: 's1' });
  requestAiPanelOpen({ sessionId: 's2' });
  assert.deepEqual(seen, [{ sessionId: 's1', seq: 1 }, { sessionId: 's2', seq: 2 }]);
  stop();
  requestAiPanelOpen({ sessionId: 's3' });
  assert.equal(seen.length, 2);
});
