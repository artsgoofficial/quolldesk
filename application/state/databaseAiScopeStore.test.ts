import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  registerDatabaseAiConnection,
  unregisterDatabaseAiConnection,
  listDatabaseAiConnections,
  getDatabaseAiConnectionBySession,
  subscribeDatabaseAiConnections,
  _resetDatabaseAiScopeForTests,
} from './databaseAiScopeStore';

test('register/list/unregister round trip', () => {
  _resetDatabaseAiScopeForTests();
  registerDatabaseAiConnection({
    connectionId: 'conn-1',
    dialect: 'mysql',
    hostname: 'db.local',
    port: 3306,
    database: 'shop',
    username: 'app',
    label: 'Shop DB',
  });
  assert.equal(listDatabaseAiConnections().length, 1);
  assert.deepEqual(listDatabaseAiConnections()[0], {
    connectionId: 'conn-1',
    dialect: 'mysql',
    hostname: 'db.local',
    port: 3306,
    database: 'shop',
    username: 'app',
    label: 'Shop DB',
  });
  unregisterDatabaseAiConnection('conn-1');
  assert.equal(listDatabaseAiConnections().length, 0);
});

test('register ignores entries without connectionId; re-register replaces', () => {
  _resetDatabaseAiScopeForTests();
  registerDatabaseAiConnection({ dialect: 'redis', connectionId: '' } as never);
  assert.equal(listDatabaseAiConnections().length, 0);
  registerDatabaseAiConnection({ connectionId: 'c1', dialect: 'redis', database: null });
  registerDatabaseAiConnection({ connectionId: 'c1', dialect: 'redis', database: '1' });
  const listed = listDatabaseAiConnections();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].database, '1');
});

test('getDatabaseAiConnectionBySession resolves the open workbench connection', () => {
  _resetDatabaseAiScopeForTests();
  assert.equal(getDatabaseAiConnectionBySession('tab-1'), null);
  registerDatabaseAiConnection({
    connectionId: 'conn-1',
    sessionId: 'tab-1',
    dialect: 'mysql',
    database: 'shop',
  });
  const found = getDatabaseAiConnectionBySession('tab-1');
  assert.ok(found);
  assert.equal(found.connectionId, 'conn-1');
  assert.equal(found.dialect, 'mysql');
  // unregistering frees the session slot
  unregisterDatabaseAiConnection('conn-1');
  assert.equal(getDatabaseAiConnectionBySession('tab-1'), null);
});

test('subscribers fire on register/unregister and unsubscribe stops them', () => {
  _resetDatabaseAiScopeForTests();
  const events: number[] = [];
  const stop = subscribeDatabaseAiConnections((connections) => events.push(connections.length));
  registerDatabaseAiConnection({ connectionId: 'c1', dialect: 'postgresql' });
  unregisterDatabaseAiConnection('c1');
  stop();
  registerDatabaseAiConnection({ connectionId: 'c2', dialect: 'redis' });
  assert.deepEqual(events, [1, 0]);
  // a throwing listener must not break others
  const broken = subscribeDatabaseAiConnections(() => { throw new Error('boom'); });
  const seen: number[] = [];
  const healthy = subscribeDatabaseAiConnections((connections) => seen.push(connections.length));
  registerDatabaseAiConnection({ connectionId: 'c3', dialect: 'mysql' });
  broken();
  healthy();
  assert.deepEqual(seen, [2]);
});
