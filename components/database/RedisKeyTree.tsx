import { ChevronDown, ChevronRight, Gauge, RefreshCw } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
// The @/ alias is the repo's sanctioned path for component-layer imports of
// infrastructure services (relative ../../infrastructure imports are eslint-restricted).
import { databaseClient, dbErrorMessage } from '@/infrastructure/services/databaseClient';
import { ContextMenu, ContextMenuTrigger } from '../ui/context-menu';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { PromptDialog } from '../ui/PromptDialog';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { toast } from '../ui/toast';
import { RedisKeyContextMenuContent, RedisKeyContextMenuHandlers } from './DatabaseTreeContextMenus';

interface RedisKeyTreeProps {
  connectionId: string;
  /** Active logical database; a change triggers a fresh SCAN. */
  db?: number;
  onSelectKey: (key: string, nodeId?: string) => void;
  refreshToken?: number;
  /** Called after a key was created here — parent bumps refreshToken to rescan. */
  onKeysChanged?: () => void;
  /** Cluster masters (workbench-shared serverInfo fetch); null on single mode. */
  clusterNodes?: { nodeId: string; host: string; port: number }[] | null;
  /** True for cluster hosts: the initial scan waits for clusterNodes. */
  clusterMode?: boolean;
  /** Opens the redis ops panel (slow log / client list). */
  onOpenOps?: () => void;
}

interface KeyEntry { name: string; nodeId?: string }

/**
 * Display form of a key inside its group: the "group:" prefix is already
 * visible on the group header, so repeating it per row only eats width.
 * Falls back to the full name whenever the prefix doesn't match exactly.
 */
const hideGroupPrefix = (name: string, group: string) => {
  if (group === '(other)' || !group) return name;
  const prefix = `${group}:`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
};

const groupKey = (name: string) => {
  const idx = name.indexOf(':');
  return idx > 0 ? name.slice(0, idx) : '(other)';
};

// ARDM-style per-type chips so the list reads like a key browser, not a file tree.
const TYPE_BADGE_CLASS: Record<string, string> = {
  string: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  hash: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  list: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  set: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  zset: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  stream: 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400',
};

const RedisKeyTree: React.FC<RedisKeyTreeProps> = ({ connectionId, db, onSelectKey, refreshToken, onKeysChanged, clusterNodes, clusterMode, onOpenOps }) => {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [entries, setEntries] = useState<KeyEntry[]>([]);
  const [cursor, setCursor] = useState<string | number>('0');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [typeByKey, setTypeByKey] = useState<Record<string, string>>({});
  // Inline "new key" mini-form (shown from the search-bar [+] button).
  const [creating, setCreating] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [creatingBusy, setCreatingBusy] = useState(false);
  // Keys already sent for TYPE lookup (ref, not state: loadMore must not
  // re-query batches whose badges are already resolved or in flight).
  const typedKeysRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Key context-menu state: delete confirm + rename/TTL prompts. Actions run
  // the same bridge writes as RedisValueViewer; toasts surface errors.
  const [deleteTarget, setDeleteTarget] = useState<KeyEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [renameTarget, setRenameTarget] = useState<KeyEntry | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [ttlTarget, setTtlTarget] = useState<KeyEntry | null>(null);
  const [ttlBusy, setTtlBusy] = useState(false);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setDebounced(search), 300);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [search]);

  // Best-effort TYPE lookup for a batch of keys (drives the list badges).
  // Cluster keys carry a nodeId, so batches are grouped per node.
  const enrichTypes = useCallback(async (added: KeyEntry[]) => {
    const pending = added.filter((e) => !typedKeysRef.current.has(e.name));
    if (pending.length === 0) return;
    for (const entry of pending) typedKeysRef.current.add(entry.name);
    const byNode = new Map<string | undefined, string[]>();
    for (const entry of pending) {
      const list = byNode.get(entry.nodeId) ?? [];
      list.push(entry.name);
      byNode.set(entry.nodeId, list);
    }
    for (const [nodeId, names] of byNode) {
      try {
        const { types } = await databaseClient.redis.keyTypes({ connectionId, keys: names, nodeId });
        if (Object.keys(types).length > 0) setTypeByKey((prev) => ({ ...prev, ...types }));
      } catch { /* badges are cosmetic; scan data already rendered */ }
    }
  }, [connectionId]);

  // One scan page, shared by the initial load and Load-more: per-node parallel
  // SCAN on clusters, plain SCAN otherwise. `replace` resets the list (initial
  // load); `isAlive` guards state writes after an unmounted initial load.
  const scanAndApply = useCallback(async (
    pageCursor: string | number,
    replace: boolean,
    isAlive: () => boolean = () => true,
  ) => {
    setLoading(true);
    try {
      let fetched: KeyEntry[] = [];
      let nextCursor: string | number = '0';
      if (clusterNodes && clusterNodes.length > 1) {
        const pages = await Promise.all(clusterNodes.map((n) =>
          databaseClient.redis.scan({ connectionId, match: debounced || undefined, cursor: pageCursor, nodeId: n.nodeId })));
        fetched = pages.flatMap((p, i) => p.keys.map((k) => ({ ...k, nodeId: k.nodeId ?? clusterNodes[i].nodeId })));
        nextCursor = pages.every((p) => String(p.cursor) === '0') ? '0' : '1';
      } else {
        const page = await databaseClient.redis.scan({ connectionId, match: debounced || undefined, cursor: pageCursor });
        fetched = page.keys;
        nextCursor = page.cursor;
      }
      if (!isAlive()) return;
      if (replace) setEntries(fetched);
      else setEntries((prev) => [...prev, ...fetched]);
      setCursor(nextCursor);
      await enrichTypes(fetched);
    } catch (err) {
      if (isAlive()) setError(dbErrorMessage(err));
    } finally {
      if (isAlive()) setLoading(false);
    }
  }, [clusterNodes, connectionId, debounced, enrichTypes]);

  useEffect(() => {
    // Cluster hosts wait for the shared node list — scanning before it arrives
    // would hit a single node and immediately re-run on the full list.
    if (clusterMode && !clusterNodes) { setLoading(true); return; }
    let alive = true;
    setLoading(true); setError(null); setEntries([]); setCursor('0'); setTypeByKey({});
    typedKeysRef.current = new Set();
    void scanAndApply('0', true, () => alive);
    return () => { alive = false; };
  }, [debounced, clusterNodes, clusterMode, refreshToken, db, scanAndApply]);

  const loadMore = () => scanAndApply(cursor, false);

  const submitNewKey = async () => {
    const key = newKeyName.trim();
    if (!key || creatingBusy) return;
    setCreatingBusy(true);
    setError(null);
    try {
      await databaseClient.redis.createKey({ connectionId, key, value: '' });
      setCreating(false);
      setNewKeyName('');
      // Parent bumps refreshToken (tree rescans) and the new key gets selected.
      onKeysChanged?.();
      onSelectKey(key);
    } catch (err) {
      setError(dbErrorMessage(err));
    } finally {
      setCreatingBusy(false);
    }
  };

  const groups = useMemo(() => {
    const map = new Map<string, KeyEntry[]>();
    for (const entry of entries) {
      const g = groupKey(entry.name);
      const list = map.get(g) ?? [];
      list.push(entry);
      map.set(g, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [entries]);

  // ——— Key context-menu actions (same bridge writes as RedisValueViewer) ———
  const copyKeyName = (key: string) => {
    navigator.clipboard.writeText(key)
      .then(() => toast.success(t('db.tree.menu.copied')))
      .catch(() => {});
  };
  const confirmRename = async (newKey: string) => {
    if (!renameTarget || renameBusy) return;
    setRenameBusy(true);
    try {
      await databaseClient.redis.renameKey({ connectionId, key: renameTarget.name, newKey, nodeId: renameTarget.nodeId });
      setRenameTarget(null);
      // Parent selects the renamed key and rescans — mirrors the viewer flow.
      onSelectKey(newKey, renameTarget.nodeId);
      onKeysChanged?.();
    } catch (err) {
      toast.error(dbErrorMessage(err));
    } finally {
      setRenameBusy(false);
    }
  };
  const confirmTtl = async (seconds: string) => {
    if (!ttlTarget || ttlBusy) return;
    const parsed = Number(seconds);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      toast.error(t('db.tree.menu.ttlInvalid'));
      return;
    }
    setTtlBusy(true);
    try {
      await databaseClient.redis.expireKey({ connectionId, key: ttlTarget.name, ttlSeconds: parsed, nodeId: ttlTarget.nodeId });
      setTtlTarget(null);
      onKeysChanged?.();
    } catch (err) {
      toast.error(dbErrorMessage(err));
    } finally {
      setTtlBusy(false);
    }
  };
  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await databaseClient.redis.deleteKey({ connectionId, key: deleteTarget.name, nodeId: deleteTarget.nodeId });
      setDeleteTarget(null);
      onKeysChanged?.();
    } catch (err) {
      toast.error(dbErrorMessage(err));
    } finally {
      setDeleting(false);
    }
  };
  const keyMenu: RedisKeyContextMenuHandlers = {
    onOpen: (key, nodeId) => onSelectKey(key, nodeId),
    onCopyName: copyKeyName,
    onTtl: (key, nodeId) => setTtlTarget({ name: key, nodeId }),
    onRemoveExpiry: (key, nodeId) => {
      databaseClient.redis.expireKey({ connectionId, key, ttlSeconds: null, nodeId })
        .then(() => onKeysChanged?.())
        .catch((err) => toast.error(dbErrorMessage(err)));
    },
    onRename: (key, nodeId) => setRenameTarget({ name: key, nodeId }),
    onDelete: (key, nodeId) => setDeleteTarget({ name: key, nodeId }),
  };

  const renderBadge = (name: string) => {
    const type = typeByKey[name];
    if (!type || type === 'none') return null;
    return (
      <span className={`px-1 py-px rounded-sm text-[9px] leading-3 font-medium flex-shrink-0 ${TYPE_BADGE_CLASS[type] ?? 'bg-muted text-muted-foreground'}`}>
        {type}
      </span>
    );
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-2 border-b border-border/60 flex items-center gap-2">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('db.workbench.searchPlaceholder')} className="h-7 text-xs" />
        <button type="button" title={t('db.redis.createKey')}
          className="h-7 w-7 flex-shrink-0 rounded border border-input text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          onClick={() => { setCreating((v) => !v); setNewKeyName(''); setError(null); }}>
          +
        </button>
        {onOpenOps && (
          <button type="button" title={t('db.redis.ops.title')}
            className="h-7 w-7 flex-shrink-0 rounded border border-input text-muted-foreground hover:bg-foreground/5 hover:text-foreground flex items-center justify-center"
            onClick={onOpenOps}>
            <Gauge size={12} />
          </button>
        )}
        <RefreshCw size={13} className={`text-muted-foreground flex-shrink-0 ${loading ? 'animate-spin' : ''}`} />
      </div>
      {creating && (
        <div className="p-2 border-b border-border/60 flex items-center gap-1">
          <Input value={newKeyName} autoFocus placeholder={t('db.redis.keyNamePlaceholder')}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitNewKey(); else if (e.key === 'Escape') setCreating(false); }}
            onChange={(e) => setNewKeyName(e.target.value)} className="h-7 flex-1 min-w-0 text-xs font-mono" />
          <Button variant="outline" size="sm" className="h-7 flex-shrink-0" disabled={creatingBusy || !newKeyName.trim()}
            onClick={() => void submitNewKey()}>{t('db.redis.createKey')}</Button>
          <Button variant="ghost" size="sm" className="h-7 flex-shrink-0" onClick={() => setCreating(false)}>{t('db.action.cancel')}</Button>
        </div>
      )}
      <div className="px-2 py-1 border-b border-border/40 text-[10px] text-muted-foreground flex items-center justify-between">
        <span>{t('db.workbench.keyCount', { count: entries.length })}</span>
        {db != null && <span>db{db}</span>}
      </div>
      <div className="flex-1 overflow-auto p-1 text-xs">
        {error && <p className="text-destructive px-2 py-1">{error}</p>}
        {!error && groups.length === 0 && !loading && (
          <p className="text-muted-foreground px-2 py-1">{t('db.workbench.noKeys')}</p>
        )}
        {groups.map(([group, keys]) => (
          <div key={group}>
            <button type="button" className="flex items-center gap-1 w-full px-2 py-1 font-medium text-foreground/80 hover:bg-foreground/5"
              onClick={() => setCollapsed((prev) => ({ ...prev, [group]: !prev[group] }))}>
              {collapsed[group] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              {group}
              <span className="text-muted-foreground ml-1">({keys.length})</span>
            </button>
            {!collapsed[group] && keys.map((entry) => (
              <ContextMenu key={`${entry.nodeId ?? ''}/${entry.name}`}>
                <ContextMenuTrigger asChild>
                  <button type="button"
                    className="flex items-center gap-1.5 w-full px-4 py-0.5 text-left hover:bg-foreground/5 truncate"
                    onClick={() => onSelectKey(entry.name, entry.nodeId)}>
                    {renderBadge(entry.name)}
                    <span className="truncate" title={entry.name}>{hideGroupPrefix(entry.name, group)}</span>
                    {entry.nodeId && <span className="ml-auto text-[10px] text-muted-foreground flex-shrink-0">{entry.nodeId}</span>}
                  </button>
                </ContextMenuTrigger>
                <RedisKeyContextMenuContent name={entry.name} nodeId={entry.nodeId} {...keyMenu} />
              </ContextMenu>
            ))}
          </div>
        ))}
        {/* SCAN routinely returns empty pages with a non-zero cursor, so the
            Load-more gate must rely on the cursor alone — gating on entries
            dead-ends sparse searches at "No keys match". */}
        {String(cursor) !== '0' && (
          <div className="p-2">
            <Button variant="outline" size="sm" className="w-full" disabled={loading} onClick={() => void loadMore()}>
              {t('db.action.loadMore')}
            </Button>
          </div>
        )}
      </div>
      {deleteTarget && (
        <ConfirmDialog
          open
          title={t('common.delete')}
          message={`${t('db.redis.deleteConfirm')}\n${deleteTarget.name}`}
          confirmLabel={t('common.delete')}
          destructive
          busy={deleting}
          onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
          onConfirm={() => void confirmDelete()}
        />
      )}
      {renameTarget && (
        <PromptDialog
          open
          title={t('db.redis.rename')}
          label={t('db.redis.keyNamePlaceholder')}
          initialValue={renameTarget.name}
          confirmLabel={t('common.rename')}
          busy={renameBusy}
          onOpenChange={(open) => { if (!open) setRenameTarget(null); }}
          onConfirm={(value) => void confirmRename(value)}
        />
      )}
      {ttlTarget && (
        <PromptDialog
          open
          title={t('db.tree.menu.ttl')}
          label={t('db.tree.menu.ttlSeconds')}
          placeholder="3600"
          confirmLabel={t('db.tree.menu.ttl')}
          busy={ttlBusy}
          onOpenChange={(open) => { if (!open) setTtlTarget(null); }}
          onConfirm={(value) => void confirmTtl(value)}
        />
      )}
    </div>
  );
};

export default RedisKeyTree;
