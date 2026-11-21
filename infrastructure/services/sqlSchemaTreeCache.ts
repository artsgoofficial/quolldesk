// Single-flight cache for the SQL schema tree. Two consumers need the same
// snapshot (SqlSchemaTree for display, SqlQueryEditor for intellisense), and
// the query editor remounts on every tab switch — without the cache each
// mount re-ran the bridge query. Keyed by dialect/connection/refreshToken so
// a designer change (bumped token) refetches.
import { databaseClient } from './databaseClient';
import type { SqlSchemaTree } from '../../types/global/quolldesk-bridge-database';

type SqlDialect = 'mysql' | 'postgresql';

const cache = new Map<string, Promise<SqlSchemaTree>>();

export function fetchSqlSchemaTree(dialect: SqlDialect, connectionId: string, refreshToken = 0): Promise<SqlSchemaTree> {
  const key = `${dialect}/${connectionId}/${refreshToken}`;
  let promise = cache.get(key);
  if (!promise) {
    promise = databaseClient[dialect].schemaTree(connectionId);
    cache.set(key, promise);
    promise.catch(() => cache.delete(key)); // failures are not cached
    // Keep only the newest token per dialect/connection (bounded growth).
    for (const existing of cache.keys()) {
      if (existing !== key && existing.startsWith(`${dialect}/${connectionId}/`)) cache.delete(existing);
    }
  }
  return promise;
}
