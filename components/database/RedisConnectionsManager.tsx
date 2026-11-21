/**
 * Redis Connections Manager - Redis-section configuration of the shared
 * DbConnectionsManager (own lazy-load chunk, see VaultView/VaultViewLayout).
 */
import React from 'react';
import DbConnectionsManager from './DbConnectionsManager';
import RedisHostDetailsPanel from './RedisHostDetailsPanel';
import type { DbConnectionsManagerOwnProps } from './DbConnectionsManager';

const RedisConnectionsManager: React.FC<DbConnectionsManagerOwnProps> = (props) => (
  <DbConnectionsManager
    {...props}
    section="redis"
    metaLine={(host) => `${host.redisConfig?.cluster ? ' · cluster' : ''}${host.redisConfig?.tunnelHostId ? ' · tunnel' : ''}`}
    detailsPanel={({ editing, sshHosts, onSave, onCancel }) => (
      <RedisHostDetailsPanel initialData={editing} sshHosts={sshHosts} onSave={onSave} onCancel={onCancel} />
    )}
  />
);

export default RedisConnectionsManager;
