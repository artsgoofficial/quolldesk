/**
 * Shared vault connections manager for the database sections (Redis and
 * Databases): host list with create/edit/duplicate/delete/connect, the
 * create/edit details panel and the delete confirmation. Section-specific
 * behavior arrives via props — which details panel opens, the row meta
 * line/badge, and whether "New" first picks a SQL dialect.
 */
import { Database, Pencil, Plus, Trash2, Copy, Play } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { Host } from '../../domain/models/connection';
import { upsertHostById } from '../../domain/host';
import { hostsForDbSection, sshTunnelCandidates } from '../../domain/models/database';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';

interface DbConnectionsManagerProps {
  section: 'redis' | 'databases';
  /** Row meta line after host:port (cluster / database / tunnel markers). */
  metaLine: (host: Host) => string;
  /** Optional leading row badge (protocol label for SQL hosts). */
  badgeLabel?: (host: Host) => string;
  /** "New" first picks a SQL dialect (databases); otherwise creates directly. */
  pickDialect?: boolean;
  /** Section details panel (create/edit form), rendered with the active dialect. */
  detailsPanel: (opts: {
    editing: Host | null;
    dialect: 'mysql' | 'postgresql';
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

const DbConnectionsManager: React.FC<DbConnectionsManagerProps & DbConnectionsManagerOwnProps> = ({
  section, metaLine, badgeLabel, pickDialect, detailsPanel,
  hosts, onUpdateHosts, onConnect,
}) => {
  const { t } = useI18n();
  const sectionHosts = useMemo(() => hostsForDbSection(hosts, section), [hosts, section]);
  const sshHosts = useMemo(() => sshTunnelCandidates(hosts), [hosts]);
  const [editing, setEditing] = useState<Host | null>(null);
  const [creating, setCreating] = useState(false);
  const [pendingDialect, setPendingDialect] = useState<'mysql' | 'postgresql' | null>(null);
  const [newDialect, setNewDialect] = useState<'mysql' | 'postgresql'>('mysql');
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
          <Button size="sm" variant="outline" onClick={() => { setCreating(true); setPendingDialect(null); setNewDialect('mysql'); }}>MySQL</Button>
          <Button size="sm" variant="outline" onClick={() => { setCreating(true); setPendingDialect(null); setNewDialect('postgresql'); }}>PostgreSQL</Button>
        </div>
      )}
      {sectionHosts.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">{t(`db.section.${section}.empty`)}</div>
      ) : (
        <div className="p-3 space-y-2 overflow-auto" style={{ height: 'calc(100% - 49px)' }}>
          {sectionHosts.map((host) => (
            <div key={host.id} className="rounded-md border border-border/60 px-3 py-2 flex items-center gap-2 hover:bg-foreground/5">
              <Database size={14} className="text-muted-foreground flex-shrink-0" />
              {badgeLabel && <Badge variant="outline">{badgeLabel(host)}</Badge>}
              <div className="min-w-0 flex-1">
                <p className="text-sm truncate">{host.label || host.hostname}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {host.hostname}:{host.port}{metaLine(host)}
                </p>
              </div>
              <Button variant="ghost" size="icon" aria-label={t('db.action.connect')} onClick={() => onConnect(host)}>
                <Play size={14} />
              </Button>
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
          ))}
        </div>
      )}
      {(creating || editing) && detailsPanel({
        editing,
        dialect: editing ? (editing.protocol === 'postgresql' ? 'postgresql' : 'mysql') : newDialect,
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
