/**
 * Lock management panel (DBeaver locks view): one dialect-specific query
 * through the existing query channel, generic table render, cancel/terminate
 * on a session id reusing the kill channel. Zero bridge changes.
 */
import type { SqlEngineId } from '../../domain/models/dbEngines';

export interface LocksQuerySet {
  sql: string;
  /** Column header whose value is a session id (drives the cancel button). */
  pidColumn: string;
}

const QUERY_SETS: Partial<Record<SqlEngineId, LocksQuerySet>> = {
  postgresql: {
    sql:
      'SELECT l.pid, a.usename AS "user", l.locktype, l.mode, ' +
      "CASE WHEN l.granted THEN 'granted' ELSE 'waiting' END AS state, " +
      'left(COALESCE(a.query, \'\'), 300) AS query ' +
      'FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid ' +
      'WHERE l.pid <> pg_backend_pid() ' +
      'ORDER BY l.granted ASC, l.pid',
    pidColumn: 'pid',
  },
  mysql: {
    sql:
      'SELECT w.waiting_pid AS pid, w.waiting_trx_id AS waiting_trx, ' +
      'w.blocking_pid AS blocking_session, w.blocking_trx_id AS blocking_trx, ' +
      "w.waiting_lock_mode AS mode, 'waiting' AS state " +
      'FROM information_schema.innodb_lock_waits w',
    pidColumn: 'pid',
  },
  mssql: {
    sql:
      'SELECT l.request_session_id AS pid, l.resource_type, l.request_mode AS mode, ' +
      'l.request_status AS state FROM sys.dm_tran_locks l ' +
      'WHERE l.request_session_id <> @@SPID',
    pidColumn: 'pid',
  },
};

export const locksQuery = (dialect: SqlEngineId): LocksQuerySet | null => QUERY_SETS[dialect] ?? null;
