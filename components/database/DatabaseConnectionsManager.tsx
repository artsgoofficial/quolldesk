/**
 * Database Connections Manager - Databases-section configuration of the
 * shared DbConnectionsManager (own lazy-load chunk, see VaultView/
 * VaultViewLayout). "New" first picks a dialect (MySQL or PostgreSQL).
 */
import React from 'react';
import DbConnectionsManager from './DbConnectionsManager';
import SqlHostDetailsPanel from './SqlHostDetailsPanel';
import type { DbConnectionsManagerOwnProps } from './DbConnectionsManager';

const DatabaseConnectionsManager: React.FC<DbConnectionsManagerOwnProps> = (props) => (
  <DbConnectionsManager
    {...props}
    section="databases"
    pickDialect
    badgeLabel={(host) => (host.protocol === 'postgresql' ? 'PostgreSQL' : 'MySQL')}
    metaLine={(host) => `${host.sqlConfig?.database ? ` / ${host.sqlConfig.database}` : ''}${host.sqlConfig?.tunnelHostId ? ' · tunnel' : ''}`}
    detailsPanel={({ editing, dialect, sshHosts, onSave, onCancel }) => (
      <SqlHostDetailsPanel initialData={editing} dialect={dialect} sshHosts={sshHosts} onSave={onSave} onCancel={onCancel} />
    )}
  />
);

export default DatabaseConnectionsManager;
