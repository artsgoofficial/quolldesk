/**
 * SQL overview dashboard (parity with RedisOverviewPanel): server/database/
 * sessions/tables info cards plus a top-tables-by-size list where the engine
 * exposes it. Full-area sqlView, one query per card through the existing
 * query channel.
 */
import { ArrowLeft, HardDrive, Layers, RefreshCw, Server, Users } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { SqlEngineId } from '../../domain/models/dbEngines';
import { databaseClient, dbErrorMessage } from '@/infrastructure/services/databaseClient';
import { overviewQueries } from './sqlOverview';
import { Button } from '../ui/button';

interface SqlOverviewPanelProps {
  connectionId: string;
  dialect: SqlEngineId;
  onClose: () => void;
}

interface CardState {
  server?: string;
  dbSize?: string;
  sessions?: string;
  tables?: string;
}

const firstCell = (res: { resultSets?: { rows?: unknown[][] }[] } | undefined): string => {
  const v = res?.resultSets?.[0]?.rows?.[0]?.[0];
  return v == null ? '' : String(v);
};

export const SqlOverviewPanel: React.FC<SqlOverviewPanelProps> = ({ connectionId, dialect, onClose }) => {
  const { t } = useI18n();
  const [cards, setCards] = useState<CardState>({});
  const [topTables, setTopTables] = useState<{ name: string; size: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const set = overviewQueries(dialect);
      const client = databaseClient[dialect];
      const [server, dbSize, sessions, tables, tablesTop] = await Promise.all([
        client.query({ connectionId, sql: set.server }).catch(() => null),
        client.query({ connectionId, sql: set.dbSize }).catch(() => null),
        client.query({ connectionId, sql: set.sessions }).catch(() => null),
        client.query({ connectionId, sql: set.tables }).catch(() => null),
        set.tablesTop
          ? client.query({ connectionId, sql: set.tablesTop }).catch(() => null)
          : Promise.resolve(null),
      ]);
      setCards({
        server: firstCell(server).split('(')[0].split(',')[0].split(' on ')[0].trim(),
        dbSize: firstCell(dbSize),
        sessions: firstCell(sessions),
        tables: firstCell(tables),
      });
      const topRows = tablesTop?.resultSets?.[0]?.rows ?? [];
      setTopTables(topRows.map((r) => ({ name: String(r[0] ?? ''), size: String(r[1] ?? '') })));
    } catch (err) {
      setError(dbErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [connectionId, dialect]);

  useEffect(() => { void load(); }, [load]);

  const cardsMeta: { key: keyof CardState; label: string; icon: React.ReactNode }[] = [
    { key: 'server', label: t('db.overview.server'), icon: <Server size={14} /> },
    { key: 'dbSize', label: t('db.overview.dbSize'), icon: <HardDrive size={14} /> },
    { key: 'sessions', label: t('db.overview.sessions'), icon: <Users size={14} /> },
    { key: 'tables', label: t('db.overview.tables'), icon: <Layers size={14} /> },
  ];

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-2 py-1.5 border-b border-border/60 flex items-center gap-1.5 shrink-0 app-no-drag">
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onClose} title={t('db.search.back')}>
          <ArrowLeft size={13} />
        </Button>
        <span className="text-xs font-medium">{t('db.overview.title')}</span>
        <Button variant="ghost" size="sm" className="h-7 px-2 ml-auto" onClick={() => void load()} disabled={loading} title={t('common.refresh')}>
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-3 text-xs">
        {error && <p className="text-destructive pb-2">{error}</p>}
        {loading && <p className="text-muted-foreground pb-2">{t('db.overview.loading')}</p>}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2 pb-3">
          {cardsMeta.map(({ key, label, icon }) => (
            <div key={key} className="soft-card rounded-lg px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-muted-foreground text-[11px] pb-1">
                {icon}
                {label}
              </div>
              <div className="font-medium truncate" title={cards[key]}>
                {cards[key] || '—'}
              </div>
            </div>
          ))}
        </div>
        {topTables.length > 0 && (
          <>
            <div className="pb-1 font-medium text-foreground/80">{t('db.overview.topTables')}</div>
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="text-left font-normal px-1.5 py-0.5">#</th>
                  <th className="text-left font-normal px-1.5 py-0.5">{t('db.overview.tableName')}</th>
                  <th className="text-left font-normal px-1.5 py-0.5">{t('db.overview.tableSize')}</th>
                </tr>
              </thead>
              <tbody>
                {topTables.map((row, i) => (
                  <tr key={row.name} className="hover:bg-foreground/5">
                    <td className="px-1.5 py-1">{i + 1}</td>
                    <td className="px-1.5 py-1 font-mono">{row.name}</td>
                    <td className="px-1.5 py-1">{row.size}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
};

export default SqlOverviewPanel;
