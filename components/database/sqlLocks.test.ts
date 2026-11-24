import assert from 'node:assert/strict';
import { test } from 'node:test';

import { locksQuery } from './sqlLocks';

test('locks queries exist for pg/mysql/mssql; sqlite unsupported', () => {
  assert.match(locksQuery('postgresql')!.sql, /pg_locks/);
  assert.match(locksQuery('postgresql')!.sql, /pg_backend_pid\(\)/);
  assert.match(locksQuery('mysql')!.sql, /innodb_lock_waits/);
  assert.match(locksQuery('mssql')!.sql, /dm_tran_locks/);
  assert.match(locksQuery('mssql')!.sql, /@@SPID/);
  assert.equal(locksQuery('sqlite'), null);
  for (const engine of ['postgresql', 'mysql', 'mssql'] as const) {
    assert.equal(locksQuery(engine)!.pidColumn, 'pid');
  }
});
