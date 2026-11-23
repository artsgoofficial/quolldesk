/**
 * Redis ops panel: slow log and client list, driven through the existing
 * runCommand channel (zero bridge changes). Replies arrive serialized by the
 * bridge, so both parsers are tolerant of the nested-array/text shapes.
 */
import { ArrowLeft, RefreshCw } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { databaseClient, dbErrorMessage } from '@/infrastructure/services/databaseClient';
import { formatBytes, parseMemoryUsageReply, parseScanReply, parseTypeReply, pickSample, type BigKeyRow } from './redisBigKeys';
import { Button } from '../ui/button';

export interface SlowlogRow {
  id: string;
  timestamp: string;
  micros: string;
  command: string;
}

export interface ClientRow {
  id: string;
  name: string;
  addr: string;
  db: string;
  age: string;
  cmd: string;
}

type OpsTab = 'slowlog' | 'clients' | 'bigkeys';

/**
 * node-redis SLOWLOG GET reply (serialized): array of
 * [id, timestampSeconds, microseconds, [verb, arg…]] — flatten the trailing
 * args array into one command string. Tolerates stringified inner arrays.
 */
export const slowlogReplyToRows = (reply: unknown): SlowlogRow[] => {
  if (!Array.isArray(reply)) return [];
  return reply
    .filter((entry): entry is unknown[] => Array.isArray(entry))
    .map((entry) => {
      const [id, timestamp, micros, commandPart] = entry;
      let command = '';
      if (Array.isArray(commandPart)) command = commandPart.join(' ');
      else if (typeof commandPart === 'string') {
        // Serialized form: "[ 'SLOWLOG','GET' ]"-ish — keep as-is.
        command = commandPart;
      }
      return {
        id: String(id ?? ''), timestamp: String(timestamp ?? ''), micros: String(micros ?? ''), command,
      };
    });
};

/** CLIENT LIST text: one client per line of `key=value` pairs. */
export const clientListTextToRows = (text: string): ClientRow[] => {
  const rows: ClientRow[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const fields: Record<string, string> = {};
    for (const pair of trimmed.split(/\s+/)) {
      const eq = pair.indexOf('=');
      if (eq > 0) fields[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    rows.push({
      id: fields.id ?? '', name: fields.name ?? '-', addr: fields.addr ?? '',
      db: fields.db ?? '', age: fields.age ?? '', cmd: fields.cmd ?? '',
    });
  }
  return rows;
};

interface RedisOpsPanelProps {
  connectionId: string;
  onClose: () => void;
}

export const RedisOpsPanel: React.FC<RedisOpsPanelProps> = ({ connectionId, onClose }) => {
  const { t } = useI18n();
  const [tab, setTab] = useState<OpsTab>('slowlog');
  const [slowlogRows, setSlowlogRows] = useState<SlowlogRow[]>([]);
  const [clientRows, setClientRows] = useState<ClientRow[]>([]);
  const [bigKeys, setBigKeys] = useState<BigKeyRow[]>([]);
  const [bigKeysProgress, setBigKeysProgress] = useState<{ scanned: number; probed: number; sample: number } | null>(null);
  const bigKeysStopRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (command: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await databaseClient.redis.runCommand({ connectionId, command });
      return res.reply;
    } catch (err) {
      setError(dbErrorMessage(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  const refresh = useCallback(async (which: OpsTab) => {
    if (which === 'slowlog') {
      const reply = await run('SLOWLOG GET 25');
      setSlowlogRows(slowlogReplyToRows(reply));
    } else {
      const reply = await run('CLIENT LIST');
      setClientRows(clientListTextToRows(typeof reply === 'string' ? reply : ''));
    }
  }, [run]);

  const analyzeBigKeys = useCallback(async () => {
    bigKeysStopRef.current = false;
    setLoading(true);
    setError(null);
    setBigKeys([]);
    try {
      // 1. collect the key universe via SCAN pages (capped).
      let cursor = '0';
      const allKeys: string[] = [];
      let pages = 0;
      do {
        const reply = await run(`SCAN ${cursor} COUNT 500`);
        const parsed = parseScanReply(reply);
        cursor = parsed.cursor;
        allKeys.push(...parsed.keys);
        pages += 1;
        setBigKeysProgress({ scanned: allKeys.length, probed: 0, sample: 0 });
      } while (cursor !== '0' && pages < 20 && !bigKeysStopRef.current);
      // 2. probe a spaced sample with TYPE + MEMORY USAGE.
      const sample = pickSample(allKeys, 100);
      const rows: BigKeyRow[] = [];
      for (const key of sample) {
        if (bigKeysStopRef.current) break;
        const type = parseTypeReply(await run(`TYPE ${key}`));
        const mem = parseMemoryUsageReply(await run(`MEMORY USAGE ${key}`));
        rows.push({ key, type, memoryBytes: mem });
        setBigKeysProgress({ scanned: allKeys.length, probed: rows.length, sample: sample.length });
      }
      rows.sort((a, b) => b.memoryBytes - a.memoryBytes);
      setBigKeys(rows);
    } finally {
      setLoading(false);
      setBigKeysProgress(null);
    }
  }, [run]);
  useEffect(() => { void refresh(tab); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

  const switchTab = (which: OpsTab) => {
    setTab(which);
    void refresh(which);
  };

  const cellCls = 'px-1.5 py-1 font-mono break-all align-top';

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-2 py-1.5 border-b border-border/60 flex items-center gap-1.5 shrink-0 app-no-drag">
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onClose} title={t('db.search.back')}>
          <ArrowLeft size={13} />
        </Button>
        <span className="text-xs font-medium">{t('db.redis.ops.title')}</span>
        {(['slowlog', 'clients', 'bigkeys'] as OpsTab[]).map((which) => (
          <button key={which} type="button"
            className={`px-2 py-1 text-xs rounded-t ${tab === which ? 'bg-foreground/10 text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'}`}
            onClick={() => switchTab(which)}>
            {t(which === 'slowlog' ? 'db.redis.ops.slowlog' : which === 'clients' ? 'db.redis.ops.clients' : 'db.redis.ops.bigkeys')}
          </button>
        ))}
        <Button variant="ghost" size="sm" className="h-7 px-2 ml-auto" disabled={loading}
          onClick={() => void refresh(tab)} title={t('common.refresh')}>
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-2 text-xs">
        {error && <p className="text-destructive px-1 py-1">{error}</p>}
        {loading && <p className="text-muted-foreground px-1 py-1">{t('db.sessions.loading')}</p>}
        {tab === 'slowlog' && slowlogRows.length > 0 && (
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-muted-foreground">
                <th className="text-left font-normal px-1.5 py-0.5">ID</th>
                <th className="text-left font-normal px-1.5 py-0.5">{t('db.redis.ops.timestamp')}</th>
                <th className="text-left font-normal px-1.5 py-0.5">{t('db.redis.ops.micros')}</th>
                <th className="text-left font-normal px-1.5 py-0.5">{t('db.sessions.query')}</th>
              </tr>
            </thead>
            <tbody>
              {slowlogRows.map((row) => (
                <tr key={row.id} className="hover:bg-foreground/5 align-top">
                  <td className={cellCls}>{row.id}</td>
                  <td className={cellCls}>{row.timestamp}</td>
                  <td className={cellCls}>{row.micros}</td>
                  <td className={cellCls}>{row.command}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === 'bigkeys' && (
          <>
            <div className="flex items-center gap-2 pb-2">
              <Button size="sm" className="h-7" disabled={loading} onClick={() => void analyzeBigKeys()}>
                {t('db.redis.ops.analyze')}
              </Button>
              {loading && bigKeysProgress && (
                <Button variant="outline" size="sm" className="h-7" onClick={() => { bigKeysStopRef.current = true; }}>
                  {t('db.transfer.stop')}
                </Button>
              )}
              {bigKeysProgress && (
                <span className="text-muted-foreground">
                  {t('db.redis.ops.scanProgress', { scanned: bigKeysProgress.scanned })}
                  {' · '}{t('db.redis.ops.probeProgress', { probed: bigKeysProgress.probed, sample: bigKeysProgress.sample })}
                </span>
              )}
            </div>
            {bigKeys.length > 0 && (
              <table className="w-full border-collapse">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="text-left font-normal px-1.5 py-0.5">#</th>
                    <th className="text-left font-normal px-1.5 py-0.5">{t('db.redis.ops.keyName')}</th>
                    <th className="text-left font-normal px-1.5 py-0.5">{t('db.workbench.keyMeta.type')}</th>
                    <th className="text-left font-normal px-1.5 py-0.5">{t('db.redis.ops.memory')}</th>
                  </tr>
                </thead>
                <tbody>
                  {bigKeys.map((row, i) => (
                    <tr key={row.key} className="hover:bg-foreground/5 align-top">
                      <td className={cellCls}>{i + 1}</td>
                      <td className={cellCls}>{row.key}</td>
                      <td className={cellCls}>{row.type}</td>
                      <td className={cellCls}>{formatBytes(row.memoryBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
        {tab === 'clients' && clientRows.length > 0 && (
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-muted-foreground">
                <th className="text-left font-normal px-1.5 py-0.5">ID</th>
                <th className="text-left font-normal px-1.5 py-0.5">{t('db.sessions.user')}</th>
                <th className="text-left font-normal px-1.5 py-0.5">{t('db.redis.ops.addr')}</th>
                <th className="text-left font-normal px-1.5 py-0.5">DB</th>
                <th className="text-left font-normal px-1.5 py-0.5">{t('db.sessions.seconds')}</th>
                <th className="text-left font-normal px-1.5 py-0.5">{t('db.sessions.query')}</th>
              </tr>
            </thead>
            <tbody>
              {clientRows.map((row) => (
                <tr key={`${row.id}-${row.addr}`} className="hover:bg-foreground/5 align-top">
                  <td className={cellCls}>{row.id}</td>
                  <td className={cellCls}>{row.name}</td>
                  <td className={cellCls}>{row.addr}</td>
                  <td className={cellCls}>{row.db}</td>
                  <td className={cellCls}>{row.age}</td>
                  <td className={cellCls}>{row.cmd}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default RedisOpsPanel;
