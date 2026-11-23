/**
 * Database Connections Manager - Databases-section configuration of the
 * shared DbConnectionsManager (own lazy-load chunk, see VaultView/
 * VaultViewLayout). "New" first picks a SQL engine (registry-driven picker);
 * rows render engine-grouped with the descriptor label as group header.
 */
import React from 'react';
import DbConnectionsManager from './DbConnectionsManager';
import SqlHostDetailsPanel from './SqlHostDetailsPanel';
import type { DbConnectionsManagerOwnProps } from './DbConnectionsManager';

const DatabaseConnectionsManager: React.FC<DbConnectionsManagerOwnProps> = (props) => (
  <DbConnectionsManager
    {...props}
    section="databases"
    metaLine={(host) => `${host.sqlConfig?.database ? ` / ${host.sqlConfig.database}` : ''}${host.sqlConfig?.tunnelHostId ? ' · tunnel' : ''}`}
    detailsPanel={({ editing, dialect, sshHosts, onSave, onCancel }) => (
      <SqlHostDetailsPanel initialData={editing} dialect={dialect} sshHosts={sshHosts} onSave={onSave} onCancel={onCancel} />
    )}
  />
);

export default DatabaseConnectionsManager;
