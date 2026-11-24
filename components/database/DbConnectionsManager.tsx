/**
 * Shared vault connections manager for the database sections (Redis and
 * Databases): host list with create/edit/duplicate/delete/connect, the
 * create/edit details panel and the delete confirmation. Section-specific
 * behavior arrives via props — which details panel opens, the row meta
 * line, and whether "New" first picks a SQL engine.
 *
 * Databases section renders engine-grouped (registry order, brand accent
 * per group); Redis stays a single flat list with the same row treatment.
 */
import { Database, Pencil, Plus, Trash2, Copy, Play, Server, Upload } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { Host } from '../../domain/models/connection';
import { upsertHostById } from '../../domain/host';
import { hostsForDbSection, sshTunnelCandidates, dbHostAccent, REDIS_HOST_ACCENT } from '../../domain/models/database';
import { SQL_ENGINES, SQL_ENGINE_BY_ID, isSqlEngineId, type SqlEngineDescriptor, type SqlEngineId } from '../../domain/models/dbEngines';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import EmptyState from '../EmptyState';
import { resolveSqlEngineForEdit } from './SqlHostDetailsPanel';

/** Row address line: file-backed engines (SQLite) live at a path, not host:port. */
export const dbRowAddressLine = (host: Pick<Host, 'hostname' | 'port' | 'protocol'>): string => {
  const engine = isSqlEngineId(host.protocol) ? SQL_ENGINE_BY_ID[host.protocol] : undefined;
  return engine?.addressMode === 'file' ? host.hostname : `${host.hostname}:${host.port}`;
};

export interface DbHostGroup { engine: SqlEngineDescriptor; hosts: Host[] }

/**
 * Databases section groups by engine (registry order, empty groups dropped,
 * label-sorted within a group); Redis renders flat → null.
 */
export const groupSectionHosts = (section: 'redis' | 'databases', hosts: Host[]): DbHostGroup[] | null => {
  if (section === 'redis') return null;
  return SQL_ENGINES
    .map((engine) => ({ engine, hosts: hosts.filter((h) => h.protocol === engine.id) }))
    .filter((group) => group.hosts.length > 0)
    .map((group) => ({
      engine: group.engine,
      hosts: [...group.hosts].sort((a, b) =>
        (a.label || a.hostname).localeCompare(b.label || b.hostname)),
    }));
};

/** Row accent: protocol brand accent (domain dbHostAccent), redis-red fallback. */
const rowAccent = (host: Host): string => dbHostAccent(host.protocol) ?? REDIS_HOST_ACCENT;

interface DbConnectionsManagerProps {
  section: 'redis' | 'databases';
  /** Row meta line after the address line (cluster / database / tunnel markers). */
  metaLine: (host: Host) => string;
  /** Section details panel (create/edit form), rendered with the active engine id. */
  detailsPanel: (opts: {
    editing: Host | null;
    dialect: SqlEngineId;
    sshHosts: Host[];
    onSave: (host: Host) => void;
    onCancel: () => void;
  }) => React.ReactNode;
}

export interface DbConnectionsManagerOwnProps {
  hosts: Host[];
  onUpdateHosts: (hosts: Host[] | ((prev: Host[]) => Host[])) => void | Promise<unknown>;
  onConnect: (host: Host) => void;
  /** Opens the shared vault import dialog (DBeaver/Navicat cards live there). */
  onImportClick?: () => void;
}

// Card language mirrors the vault host grid (soft-card elevate rounded-xl).
const cardClasses =
  'group/row soft-card elevate rounded-xl h-[68px] px-3 py-2 relative cursor-pointer '
  + 'flex items-center transition-[opacity,box-shadow,border-color,background-color] duration-150 '
  + 'hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
const secondaryActions =
  'flex items-center opacity-0 group-hover/row:opacity-100 '
  + 'focus-within:opacity-100 transition-opacity';
const cardGrid = 'grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3';

const DbConnectionsManager: React.FC<DbConnectionsManagerProps & DbConnectionsManagerOwnProps> = ({
  section, metaLine, detailsPanel,
  hosts, onUpdateHosts, onConnect, onImportClick,
}) => {
  const { t } = useI18n();
  const sectionHosts = useMemo(() => hostsForDbSection(hosts, section), [hosts, section]);
  const sshHosts = useMemo(() => sshTunnelCandidates(hosts), [hosts]);
  const groups = useMemo(() => groupSectionHosts(section, sectionHosts), [section, sectionHosts]);
  const [editing, setEditing] = useState<Host | null>(null);
  const [creating, setCreating] = useState(false);
  const [newDialect, setNewDialect] = useState<SqlEngineId>('mysql');
  const [deleteTarget, setDeleteTarget] = useState<Host | null>(null);

  const save = (host: Host) => {
    void onUpdateHosts((prev) => upsertHostById(prev, host));
    setEditing(null);
    setCreating(false);
  };

  // "New" opens the details panel directly — the engine type is switched
  // inside the form (SqlHostDetailsPanel engine row), no pre-picker popup.
  const openNew = () => {
    setCreating(true);
    setEditing(null);
  };

  const openEdit = (host: Host) => {
    setEditing(host);
    setCreating(false);
  };

  const hostCard = (host: Host) => (
    <div
      key={host.id}
      className={`${cardClasses} ${host.dbColor ? 'border-l-4' : ''}`}
      style={host.dbColor ? { borderLeftColor: host.dbColor } : undefined}
      role="button"
      tabIndex={0}
      aria-label={`${host.label || host.hostname} · ${t('db.action.connect')}`}
      onClick={() => onConnect(host)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onConnect(host);
      }}
    >
      <div className="flex items-center gap-3 h-full min-w-0">
        <div
          className="h-10 w-10 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: rowAccent(host) }}
          aria-hidden
        >
          <Database size={18} className="text-white" />
        </div>
        <div className="min-w-0 flex flex-col justify-center gap-0.5 flex-1">
          <span className="text-sm font-semibold truncate leading-5">{host.label || host.hostname}</span>
          <span className="text-[11px] text-muted-foreground font-mono truncate leading-4">
            {dbRowAddressLine(host)}{metaLine(host)}
          </span>
        </div>
      </div>
      <div className="absolute top-1 right-1 flex items-center">
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('db.action.connect')} onClick={(e) => { e.stopPropagation(); onConnect(host); }}>
          <Play size={14} />
        </Button>
        <div className={secondaryActions}>
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('db.action.edit')} onClick={(e) => { e.stopPropagation(); openEdit(host); }}>
            <Pencil size={13} />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('db.action.duplicate')}
            onClick={(e) => { e.stopPropagation(); void onUpdateHosts((prev) => [...prev, { ...host, id: crypto.randomUUID(), label: `${host.label || host.hostname} copy` }]); }}>
            <Copy size={13} />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('db.action.delete')} onClick={(e) => { e.stopPropagation(); setDeleteTarget(host); }}>
            <Trash2 size={13} />
          </Button>
        </div>
      </div>
    </div>
  );

  const groupedHeader = (engine: SqlEngineDescriptor, count: number) => (
    <div className="flex items-center gap-2 pt-5 pb-2 first:pt-1">
      <span className="w-1 h-4 rounded-full flex-shrink-0" style={{ backgroundColor: engine.accent }} aria-hidden />
      <span className="text-sm font-semibold" style={{ color: engine.accent }}>{engine.label}</span>
      <span className="text-[11px] text-muted-foreground">{count}</span>
    </div>
  );

  return (
    <div className="relative h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
        <h2 className="text-sm font-medium">{t(`db.section.${section}.title`)}</h2>
        <div className="flex items-center gap-2">
          {onImportClick && (
            <Button size="sm" variant="outline" onClick={onImportClick}>
              <Upload size={14} className="mr-1" />{t('vault.hosts.import')}
            </Button>
          )}
          <Button size="sm" onClick={openNew}>
            <Plus size={14} className="mr-1" />{t('db.action.new')}
          </Button>
        </div>
      </div>
      {sectionHosts.length === 0 ? (
        <EmptyState
          icon={section === 'redis' ? <Server size={30} /> : <Database size={30} />}
          title={t(`db.section.${section}.empty`)}
          actions={(
            <div className="flex items-center gap-2">
              {onImportClick && (
                <Button size="sm" variant="outline" onClick={onImportClick}>
                  <Upload size={14} className="mr-1" />{t('vault.hosts.import')}
                </Button>
              )}
              <Button size="sm" onClick={openNew}>
                <Plus size={14} className="mr-1" />{t('db.action.new')}
              </Button>
            </div>
          )}
        />
      ) : (
        <div className="px-4 pb-4 overflow-auto" style={{ height: 'calc(100% - 49px)' }}>
          {groups
            ? groups.map((group) => (
              <section key={group.engine.id} aria-label={group.engine.label}>
                {groupedHeader(group.engine, group.hosts.length)}
                <div className={cardGrid}>{group.hosts.map(hostCard)}</div>
              </section>
            ))
            : <div className={`pt-2 ${cardGrid}`}>{sectionHosts.map(hostCard)}</div>}
        </div>
      )}
      {(creating || editing) && detailsPanel({
        editing,
        dialect: editing ? resolveSqlEngineForEdit(editing, newDialect) : newDialect,
        sshHosts,
        onSave: save,
        onCancel: () => { setCreating(false); setEditing(null); },
      })}
      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('db.action.delete')}
        message={t('db.action.deleteConfirm', { label: deleteTarget ? (deleteTarget.label || deleteTarget.hostname) : '' })}
        confirmLabel={t('db.action.delete')}
        destructive
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        onConfirm={() => {
          if (deleteTarget) {
            void onUpdateHosts((prev) => prev.filter((h) => h.id !== deleteTarget.id));
            setDeleteTarget(null);
          }
        }}
      />
    </div>
  );
};

export default DbConnectionsManager;
