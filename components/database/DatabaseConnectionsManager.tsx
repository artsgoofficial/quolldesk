/**
 * Database Connections Manager - Databases-section configuration of the
 * shared DbConnectionsManager (own lazy-load chunk, see VaultView/
 * VaultViewLayout). "New" first picks a SQL engine (registry-driven picker);
 * rows render engine-grouped with the descriptor label as group header.
 */
import React from 'react';
import type { Host } from '../../domain/models/connection';
import { SQL_ENGINE_BY_ID, isSqlEngineId } from '../../domain/models/dbEngines';
import DbConnectionsManager from './DbConnectionsManager';
import SqlHostDetailsPanel from './SqlHostDetailsPanel';
import type { DbConnectionsManagerOwnProps } from './DbConnectionsManager';

/** Engine label for a databases-section host (group header / badge source). */
export const sqlBadgeLabel = (protocol: Host['protocol'] | undefined): string =>
  isSqlEngineId(protocol) ? SQL_ENGINE_BY_ID[protocol].label : 'SQL';

const DatabaseConnectionsManager: React.FC<DbConnectionsManagerOwnProps> = (props) => (
  <DbConnectionsManager
    {...props}
    section="databases"
    pickDialect
    metaLine={(host) => `${host.sqlConfig?.database ? ` / ${host.sqlConfig.database}` : ''}${host.sqlConfig?.tunnelHostId ? ' · tunnel' : ''}`}
    detailsPanel={({ editing, dialect, sshHosts, onSave, onCancel }) => (
      <SqlHostDetailsPanel initialData={editing} dialect={dialect} sshHosts={sshHosts} onSave={onSave} onCancel={onCancel} />
    )}
  />
);

export default DatabaseConnectionsManager;
