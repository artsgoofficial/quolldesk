import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
// The @/ alias is the repo's sanctioned path for component-layer imports of
// infrastructure services (relative ../../infrastructure imports are eslint-restricted).
import { databaseClient, dbErrorMessage } from '@/infrastructure/services/databaseClient';
import type { RedisKeyMeta, RedisKeyValuePage } from '../../types/global/quolldesk-bridge-database';
import { formatMaybeJson } from './format';
import JsonCodeArea, { highlightJson } from './JsonCodeArea';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';

interface RedisValueViewerProps {
  connectionId: string;
  selectedKey: string | null;
  nodeId?: string;
  refreshToken?: number;
  /** Keyspace changed (key renamed/deleted from here) — parent rescans the tree. */
  onKeysChanged?: () => void;
  /** After a successful rename the parent should select the new key. */
  onKeyRenamed?: (newKey: string) => void;
}

// Bridge wire contracts (quolldesk-bridge-database) instead of local copies.
type Meta = RedisKeyMeta;
type Row = RedisKeyValuePage['items'][number];

// Types with per-row delete + footer add-row editors. stream/unknown stay read-only.
const EDITABLE_TYPES = new Set(['hash', 'list', 'set', 'zset']);

const META_ACTION_CLASS = 'px-1.5 py-0.5 rounded text-[11px] text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-50';

const RedisValueViewer: React.FC<RedisValueViewerProps> = ({
  connectionId, selectedKey, nodeId, refreshToken, onKeysChanged, onKeyRenamed,
}) => {
  const { t } = useI18n();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [truncated, setTruncated] = useState(false);
  // Hash/set pages carry the redis scan cursor (string); list/zset use an index.
  const [cursor, setCursor] = useState<string | number>(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // null = auto: JSON-detected strings render pretty; false forces raw text.
  const [jsonView, setJsonView] = useState<boolean | null>(null);
  // Bumped after a successful write so the load effect re-fetches meta + page 0
  // (editing must not preserve pagination: reload page 0 for the key).
  const [reloadTick, setReloadTick] = useState(0);
  // Inline meta-header editors.
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [ttlOpen, setTtlOpen] = useState(false);
  const [ttlValue, setTtlValue] = useState('');
  const ttlSeconds = Number(ttlValue.trim());
  const ttlValid = /^\d+$/.test(ttlValue.trim()) && ttlSeconds > 0;
  // String value draft (textarea).
  const [stringDraft, setStringDraft] = useState('');
  // Per-type footer add-row inputs.
  const [hashField, setHashField] = useState('');
  const [hashValue, setHashValue] = useState('');
  const [listValue, setListValue] = useState('');
  const [setMember, setSetMember] = useState('');
  const [zsetMember, setZsetMember] = useState('');
  const [zsetScore, setZsetScore] = useState('');
  const zsetScoreNumber = Number(zsetScore.trim());
  const zsetScoreValid = zsetScore.trim() !== '' && Number.isFinite(zsetScoreNumber);

  useEffect(() => {
    if (!selectedKey) { setMeta(null); setRows([]); return; }
    let alive = true;
    setLoading(true); setError(null); setJsonView(null);
    (async () => {
      try {
        const m = await databaseClient.redis.keyMeta({ connectionId, key: selectedKey, nodeId });
        if (!alive) return;
        setMeta(m);
        const page = await databaseClient.redis.keyValue({ connectionId, key: selectedKey, type: m.type, cursor: 0, nodeId });
        if (!alive) return;
        setRows(page.items);
        setHasMore(!!page.hasMore);
        setTruncated(!!page.truncated);
        setCursor(page.cursor ?? 0);
      } catch (err) {
        if (alive) setError(dbErrorMessage(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [connectionId, selectedKey, nodeId, refreshToken, reloadTick]);

  // Keep the string draft in sync with the loaded value; syncs only when the
  // underlying value actually changes, so in-flight edits are not clobbered.
  const rawStringValue = rows[0]?.value ?? '';
  useEffect(() => { setStringDraft(rawStringValue); }, [rawStringValue, selectedKey]);

  // JSON detection/highlighting is precomputed once per fetched page — running
  // formatMaybeJson per row on every render re-parsed every value on each
  // keystroke in the add-row inputs.
  const renderedRows = useMemo(() => rows.map((row) => {
    const detected = formatMaybeJson(row.value);
    return {
      ...row,
      jsonBody: detected.isJson ? highlightJson(detected.formatted) : null,
    };
  }), [rows]);
  // String view: same precompute for the single loaded value.
  const stringDetection = useMemo(() => formatMaybeJson(rawStringValue), [rawStringValue]);

  const reload = useCallback(() => {
    setRenameOpen(false);
    setConfirmDelete(false);
    setTtlOpen(false);
    setReloadTick((v) => v + 1);
  }, []);

  const loadMore = async () => {
    if (!selectedKey || !meta) return;
    setLoading(true);
    try {
      const page = await databaseClient.redis.keyValue({ connectionId, key: selectedKey, type: meta.type, cursor, count: 200, nodeId });
      setRows((prev) => [...prev, ...page.items]);
      setHasMore(!!page.hasMore);
      setTruncated((prevTruncated) => prevTruncated || !!page.truncated);
      setCursor(page.cursor ?? cursor);
    } catch (err) {
      setError(dbErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  /** Shared write helper: driver errors surface in the inline error area. */
  const runWrite = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setSaving(true);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(dbErrorMessage(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleRename = async () => {
    if (!selectedKey || saving || !renameValue.trim()) return;
    const newKey = renameValue.trim();
    if (await runWrite(() => databaseClient.redis.renameKey({ connectionId, key: selectedKey, newKey, nodeId }))) {
      setRenameOpen(false);
      // Parent selects the renamed key and rescans the tree; reloadTick keeps
      // this correct even when the parent opts out of the callbacks.
      onKeyRenamed?.(newKey);
      onKeysChanged?.();
      setReloadTick((v) => v + 1);
    }
  };

  const handleDelete = async () => {
    if (!selectedKey || saving) return;
    if (await runWrite(() => databaseClient.redis.deleteKey({ connectionId, key: selectedKey, nodeId }))) {
      setConfirmDelete(false);
      setMeta(null);
      setRows([]);
      onKeysChanged?.();
    }
  };

  const saveTtl = async (seconds: number | null) => {
    if (!selectedKey || saving) return;
    if (await runWrite(() => databaseClient.redis.expireKey({ connectionId, key: selectedKey, ttlSeconds: seconds, nodeId }))) {
      reload();
    }
  };

  const saveString = async () => {
    if (!selectedKey || saving) return;
    if (await runWrite(() => databaseClient.redis.setStringValue({ connectionId, key: selectedKey, value: stringDraft, nodeId }))) {
      reload();
    }
  };

  const deleteRow = async (row: Row) => {
    if (!selectedKey || !meta || saving) return;
    const type = meta.type;
    const pending =
      type === 'hash' ? databaseClient.redis.hashDeleteField({ connectionId, key: selectedKey, field: String(row.index), nodeId })
        : type === 'list' ? databaseClient.redis.listRemoveValue({ connectionId, key: selectedKey, value: row.value ?? '', nodeId })
          : type === 'set' ? databaseClient.redis.setRemoveMember({ connectionId, key: selectedKey, member: row.value ?? '', nodeId })
            : type === 'zset' ? databaseClient.redis.zsetRemoveMember({ connectionId, key: selectedKey, member: row.value ?? '', nodeId })
              : Promise.resolve();
    if (await runWrite(() => pending)) reload();
  };

  const addHashField = async () => {
    if (!selectedKey || saving || !hashField.trim() || !hashValue) return;
    if (await runWrite(() => databaseClient.redis.hashSetField({ connectionId, key: selectedKey, field: hashField.trim(), value: hashValue, nodeId }))) {
      setHashField(''); setHashValue('');
      reload();
    }
  };

  const pushList = async (position: 'left' | 'right') => {
    if (!selectedKey || saving || !listValue) return;
    if (await runWrite(() => databaseClient.redis.listPush({ connectionId, key: selectedKey, position, value: listValue, nodeId }))) {
      setListValue('');
      reload();
    }
  };

  const addSetMember = async () => {
    if (!selectedKey || saving || !setMember) return;
    if (await runWrite(() => databaseClient.redis.setAddMember({ connectionId, key: selectedKey, member: setMember, nodeId }))) {
      setSetMember('');
      reload();
    }
  };

  const addZsetMember = async () => {
    if (!selectedKey || saving || !zsetMember.trim() || !zsetScoreValid) return;
    if (await runWrite(() => databaseClient.redis.zsetAddMember({ connectionId, key: selectedKey, member: zsetMember.trim(), score: zsetScoreNumber, nodeId }))) {
      setZsetMember(''); setZsetScore('');
      reload();
    }
  };

  if (!selectedKey) {
    return <div className="p-4 text-sm text-muted-foreground">{t('db.workbench.noSelection')}</div>;
  }

  const editable = !!meta && EDITABLE_TYPES.has(meta.type);

  return (
    <div className="flex flex-col h-full min-h-0">
      {meta && (
        <div className="px-3 py-2 border-b border-border/60 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {renameOpen ? (
            <span className="flex items-center gap-1">
              <Input value={renameValue} autoFocus onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleRename(); else if (e.key === 'Escape') setRenameOpen(false); }}
                className="h-6 w-52 text-xs font-mono" aria-label={t('db.redis.rename')} />
              <Button variant="outline" size="sm" className="h-7 px-3 text-xs" disabled={saving || !renameValue.trim()}
                onClick={() => void handleRename()}>{t('db.action.save')}</Button>
              <Button variant="ghost" size="sm" className="h-7 px-3 text-xs" onClick={() => setRenameOpen(false)}>{t('db.action.cancel')}</Button>
            </span>
          ) : (
            <span className="font-mono text-foreground max-w-[240px] truncate" title={selectedKey ?? undefined}>{selectedKey}</span>
          )}
          <span>{t('db.workbench.keyMeta.type')}: <b className="text-foreground">{meta.type}</b></span>
          {ttlOpen ? (
            <span className="flex items-center gap-1">
              <span>{t('db.workbench.keyMeta.ttl')}:</span>
              <Input value={ttlValue} inputMode="numeric" autoFocus onChange={(e) => setTtlValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && ttlValid) void saveTtl(ttlSeconds); else if (e.key === 'Escape') setTtlOpen(false); }}
                aria-label={t('db.workbench.keyMeta.ttl')} className="h-6 w-20 text-xs" />
              <span>s</span>
              <Button variant="outline" size="sm" className="h-7 px-3 text-xs" disabled={saving || !ttlValid}
                onClick={() => void saveTtl(ttlSeconds)}>{t('db.action.save')}</Button>
              <Button variant="ghost" size="sm" className="h-7 px-3 text-xs" disabled={saving}
                onClick={() => void saveTtl(null)}>{t('db.redis.removeExpiry')}</Button>
              <Button variant="ghost" size="sm" className="h-7 px-3 text-xs" onClick={() => setTtlOpen(false)}>{t('db.action.cancel')}</Button>
            </span>
          ) : (
            <span>{t('db.workbench.keyMeta.ttl')}: {meta.ttlMs == null || meta.ttlMs < 0 ? t('db.workbench.keyMeta.ttlForever') : `${Math.round(meta.ttlMs / 1000)}s`}</span>
          )}
          {meta.sizeBytes != null && <span>{t('db.workbench.keyMeta.size')}: {meta.sizeBytes}B</span>}
          {confirmDelete ? (
            <span className="ml-auto flex items-center gap-1">
              <span className="text-destructive">{t('db.redis.deleteConfirm')}</span>
              <Button variant="destructive" size="sm" className="h-7 px-3 text-xs" disabled={saving}
                onClick={() => void handleDelete()}>{t('db.action.delete')}</Button>
              <Button variant="ghost" size="sm" className="h-7 px-3 text-xs" onClick={() => setConfirmDelete(false)}>{t('db.action.cancel')}</Button>
            </span>
          ) : !renameOpen && !ttlOpen && (
            <span className="ml-auto flex items-center gap-1">
              <button type="button" className={META_ACTION_CLASS} onClick={() => { setRenameValue(selectedKey ?? ''); setRenameOpen(true); }}>
                {t('db.redis.rename')}
              </button>
              <button type="button" className={META_ACTION_CLASS}
                onClick={() => { setTtlValue(meta.ttlMs != null && meta.ttlMs >= 0 ? String(Math.round(meta.ttlMs / 1000)) : ''); setTtlOpen(true); }}>
                {t('db.workbench.keyMeta.ttl')}
              </button>
              <button type="button" className={`${META_ACTION_CLASS} hover:text-destructive`} onClick={() => setConfirmDelete(true)}>
                {t('db.action.delete')}
              </button>
            </span>
          )}
        </div>
      )}
      {error && <p className="text-destructive text-xs px-3 py-2">{error}</p>}
      <div className="flex-1 overflow-auto p-3 text-xs">
        {meta?.type === 'string' ? (() => {
          const detected = stringDetection;
          const showPretty = jsonView !== false && detected.isJson;
          // While the draft is unmodified, JSON view renders the pretty-printed
          // value; once the user edits, the textarea shows the draft verbatim.
          const displayValue = showPretty && stringDraft === rawStringValue ? detected.formatted : stringDraft;
          return (
            <>
              <div className="flex items-center gap-1 mb-1">
                {detected.isJson && (
                  <span className="px-1 py-px rounded-sm text-[9px] leading-3 font-medium bg-sky-500/15 text-sky-600 dark:text-sky-400">JSON</span>
                )}
                <div className="flex gap-0.5 ml-auto items-center">
                  <button type="button" className={`px-1.5 py-0.5 rounded text-[10px] ${!showPretty ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:bg-foreground/5'}`}
                    onClick={() => setJsonView(false)}>{t('db.value.raw')}</button>
                  <button type="button" className={`px-1.5 py-0.5 rounded text-[10px] ${showPretty ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:bg-foreground/5'}`}
                    onClick={() => setJsonView(true)}>{detected.isJson ? 'JSON' : 'Formatted'}</button>
                  <button type="button"
                    className="ml-2 px-2 py-0.5 rounded text-[10px] bg-emerald-600/15 text-emerald-600 hover:bg-emerald-600/25 dark:text-emerald-400 disabled:opacity-50"
                    disabled={saving || stringDraft === rawStringValue}
                    onClick={() => void saveString()}>{t('db.redis.saveChanges')}</button>
                </div>
              </div>
              {showPretty && detected.isJson ? (
                <JsonCodeArea value={displayValue} onChange={setStringDraft} />
              ) : (
                <Textarea value={stringDraft} spellCheck={false}
                  onChange={(e) => setStringDraft(e.target.value)}
                  className="font-mono text-xs min-h-[160px] whitespace-pre-wrap break-all bg-foreground/5" />
              )}
            </>
          );
        })() : (
          <>
            <table className="w-full border-collapse">
              <tbody>
                {renderedRows.map((row, i) => (
                  <tr key={`${row.index}/${i}`} className="border-b border-border/40">
                    <td className="py-1 pr-3 text-muted-foreground align-top whitespace-nowrap">{row.score != null ? `(${row.score}) ` : ''}{String(row.index)}</td>
                    <td className="py-1 font-mono break-all">
                      {row.jsonBody != null
                        ? <pre className="whitespace-pre-wrap break-all font-mono m-0">{row.jsonBody}</pre>
                        : String(row.value ?? '')}
                    </td>
                    {editable && (
                      <td className="py-0.5 pl-2 align-top">
                        <button type="button" disabled={saving}
                          className="px-1.5 py-0.5 rounded text-[10px] text-destructive hover:bg-destructive/10 disabled:opacity-50"
                          onClick={() => void deleteRow(row)}>{t('db.action.delete')}</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {editable && (
              <div className="flex flex-wrap items-center gap-1 mt-2">
                {meta?.type === 'hash' && (
                  <>
                    <Input className="h-7 w-36 text-xs" placeholder={t('db.redis.fieldPlaceholder')} value={hashField}
                      onChange={(e) => setHashField(e.target.value)} />
                    <Input className="h-7 flex-1 min-w-[120px] text-xs" placeholder={t('db.redis.valuePlaceholder')} value={hashValue}
                      onChange={(e) => setHashValue(e.target.value)} />
                    <Button variant="outline" size="sm" className="h-7" disabled={saving || !hashField.trim() || !hashValue}
                      onClick={() => void addHashField()}>+ {t('db.redis.addField')}</Button>
                  </>
                )}
                {meta?.type === 'list' && (
                  <>
                    <Input className="h-7 flex-1 min-w-[120px] text-xs" placeholder={t('db.redis.valuePlaceholder')} value={listValue}
                      onChange={(e) => setListValue(e.target.value)} />
                    <Button variant="outline" size="sm" className="h-7" disabled={saving || !listValue}
                      onClick={() => void pushList('left')}>+ {t('db.redis.pushHead')}</Button>
                    <Button variant="outline" size="sm" className="h-7" disabled={saving || !listValue}
                      onClick={() => void pushList('right')}>+ {t('db.redis.pushTail')}</Button>
                  </>
                )}
                {meta?.type === 'set' && (
                  <>
                    <Input className="h-7 flex-1 min-w-[120px] text-xs" placeholder={t('db.redis.memberPlaceholder')} value={setMember}
                      onChange={(e) => setSetMember(e.target.value)} />
                    <Button variant="outline" size="sm" className="h-7" disabled={saving || !setMember}
                      onClick={() => void addSetMember()}>+ {t('db.redis.addMember')}</Button>
                  </>
                )}
                {meta?.type === 'zset' && (
                  <>
                    <Input className="h-7 w-40 text-xs" placeholder={t('db.redis.memberPlaceholder')} value={zsetMember}
                      onChange={(e) => setZsetMember(e.target.value)} />
                    <Input className="h-7 w-24 text-xs" inputMode="decimal" placeholder={t('db.redis.scorePlaceholder')} value={zsetScore}
                      onChange={(e) => setZsetScore(e.target.value)} />
                    <Button variant="outline" size="sm" className="h-7" disabled={saving || !zsetMember.trim() || !zsetScoreValid}
                      onClick={() => void addZsetMember()}>+ {t('db.redis.addMember')}</Button>
                  </>
                )}
              </div>
            )}
          </>
        )}
        {truncated && <p className="text-amber-500 text-xs mt-2">{t('db.workbench.truncated')}</p>}
        {hasMore && (
          <Button variant="outline" size="sm" className="mt-2" disabled={loading} onClick={loadMore}>
            {t('db.action.loadMore')}
          </Button>
        )}
      </div>
    </div>
  );
};

export default RedisValueViewer;
