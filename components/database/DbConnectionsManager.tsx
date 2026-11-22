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
import { Pencil, Plus, Trash2, Copy, Play } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { Host } from '../../domain/models/connection';
import { upsertHostById } from '../../domain/host';
import { hostsForDbSection, sshTunnelCandidates } from '../../domain/models/database';
import { SQL_ENGINES, SQL_ENGINE_BY_ID, isSqlEngineId, type SqlEngineDescriptor, type SqlEngineId } from '../../domain/models/dbEngines';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { resolveSqlEngineForEdit } from './SqlHostDetailsPanel';

/** Row address line: file-backed engines (SQLite) live at a path, not host:port. */
export const dbRowAddressLine = (host: Pick<Host, 'hostname' | 'port' | 'protocol'>): string => {
  const engine = isSqlEngineId(host.protocol) ? SQL_ENGINE_BY_ID[host.protocol] : undefined;
  return engine?.addressMode === 'file' ? host.hostname : `${host.hostname}:${host.port}`;
};

/** Redis flat-list accent (brand red) — redis hosts have no registry descriptor. */
const REDIS_ACCENT = '#D44B4B';

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

const rowAccent = (host: Host): string =>
  isSqlEngineId(host.protocol) ? SQL_ENGINE_BY_ID[host.protocol].accent : REDIS_ACCENT;

interface DbConnectionsManagerProps {
  section: 'redis' | 'databases';
  /** Row meta line after the address line (cluster / database / tunnel markers). */
  metaLine: (host: Host) => string;
  /** "New" first picks a SQL engine (databases); otherwise creates directly. */
  pickDialect?: boolean;
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
}

const rowClasses =
  'group/row rounded-lg border border-border/50 px-3 py-2 flex items-center gap-2.5 '
  + 'hover:bg-foreground/5 hover:border-border transition-colors';
const secondaryActions =
  'flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 '
  + 'focus-within:opacity-100 transition-opacity';

const DbConnectionsManager: React.FC<DbConnectionsManagerProps & DbConnectionsManagerOwnProps> = ({
  section, metaLine, pickDialect, detailsPanel,
  hosts, onUpdateHosts, onConnect,
}) => {
  const { t } = useI18n();
  const sectionHosts = useMemo(() => hostsForDbSection(hosts, section), [hosts, section]);
  const sshHosts = useMemo(() => sshTunnelCandidates(hosts), [hosts]);
  const groups = useMemo(() => groupSectionHosts(section, sectionHosts), [section, sectionHosts]);
  const [editing, setEditing] = useState<Host | null>(null);
  const [creating, setCreating] = useState(false);
  const [pendingDialect, setPendingDialect] = useState<SqlEngineId | null>(null);
  const [newDialect, setNewDialect] = useState<SqlEngineId>('mysql');
  const [deleteTarget, setDeleteTarget] = useState<Host | null>(null);

  const save = (host: Host) => {
    void onUpdateHosts((prev) => upsertHostById(prev, host));
    setEditing(null);
    setCreating(false);
  };

  const openNew = () => {
    if (pickDialect) {
      setPendingDialect('mysql');
      setEditing(null);
    } else {
      setCreating(true);
      setEditing(null);
    }
  };

  const openEdit = (host: Host) => {
    setEditing(host);
    setCreating(false);
    setPendingDialect(null);
  };

  const hostRow = (host: Host) => (
    <div key={host.id} className={rowClasses}>
      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: rowAccent(host) }} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm truncate leading-tight">{host.label || host.hostname}</p>
        <p className="text-xs text-muted-foreground truncate mt-0.5">
          {dbRowAddressLine(host)}{metaLine(host)}
        </p>
      </div>
      <Button variant="ghost" size="icon" className="flex-shrink-0" aria-label={t('db.action.connect')} onClick={() => onConnect(host)}>
        <Play size={14} />
      </Button>
      <div className={secondaryActions}>
        <Button variant="ghost" size="icon" aria-label={t('db.action.edit')} onClick={() => openEdit(host)}>
          <Pencil size={14} />
        </Button>
        <Button variant="ghost" size="icon" aria-label={t('db.action.duplicate')}
          onClick={() => void onUpdateHosts((prev) => [...prev, { ...host, id: crypto.randomUUID(), label: `${host.label || host.hostname} copy` }])}>
          <Copy size={14} />
        </Button>
        <Button variant="ghost" size="icon" aria-label={t('db.action.delete')} onClick={() => setDeleteTarget(host)}>
          <Trash2 size={14} />
        </Button>
      </div>
    </div>
  );

  const groupedHeader = (engine: SqlEngineDescriptor, count: number) => (
    <div className="flex items-center gap-2 pt-4 pb-1.5 first:pt-0.5">
      <span className="w-1 h-3.5 rounded-full flex-shrink-0" style={{ backgroundColor: engine.accent }} aria-hidden />
      <span className="text-xs font-medium text-foreground/80">{engine.label}</span>
      <span className="text-[11px] text-muted-foreground">{count}</span>
    </div>
  );

  return (
    <div className="relative h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
        <h2 className="text-sm font-medium">{t(`db.section.${section}.title`)}</h2>
        <Button size="sm" onClick={openNew}>
          <Plus size={14} className="mr-1" />{t('db.action.new')}
        </Button>
      </div>
      {pendingDialect && !editing && (
        <div className="absolute right-4 top-12 z-30 rounded-md border border-border/60 bg-background p-2 flex gap-2 shadow">
          {SQL_ENGINES.map((engine) => (
            <Button key={engine.id} size="sm" variant="outline"
              onClick={() => { setCreating(true); setPendingDialect(null); setNewDialect(engine.id); }}>
              {engine.label}
            </Button>
          ))}
        </div>
      )}
      {sectionHosts.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">{t(`db.section.${section}.empty`)}</div>
      ) : (
        <div className="px-3 pb-3 overflow-auto" style={{ height: 'calc(100% - 49px)' }}>
          {groups
            ? groups.map((group) => (
              <section key={group.engine.id} aria-label={group.engine.label}>
                {groupedHeader(group.engine, group.hosts.length)}
                <div className="space-y-1">{group.hosts.map(hostRow)}</div>
              </section>
            ))
            : <div className="pt-2 space-y-2">{sectionHosts.map(hostRow)}</div>}
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
