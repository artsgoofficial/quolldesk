/**
 * Session manager panel (DBeaver-style): live server sessions of the current
 * database with terminate / cancel actions. SQL dialects only (sqlite has no
 * server sessions) — gated by features.sessions in the workbench.
 */
import { Ban, Square } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { SqlEngineId } from '../../domain/models/dbEngines';
import { databaseClient, dbErrorMessage } from '@/infrastructure/services/databaseClient';
import type { SqlSessionInfo } from '../../types/global/quolldesk-bridge-database';
import SqlPanelHeader from './SqlPanelHeader';
import { toast } from '../ui/toast';

interface SqlSessionsPanelProps {
  connectionId: string;
  dialect: SqlEngineId;
  onClose: () => void;
}

export const SqlSessionsPanel: React.FC<SqlSessionsPanelProps> = ({ connectionId, dialect, onClose }) => {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<SqlSessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await databaseClient[dialect].sessions({ connectionId });
      setSessions(res.sessions);
    } catch (err) {
      setError(dbErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [connectionId, dialect]);

  useEffect(() => { void refresh(); }, [refresh]);

  const kill = useCallback(async (session: SqlSessionInfo, cancel: boolean) => {
    setBusyId(session.id);
    try {
      await databaseClient[dialect].killSession({ connectionId, pid: session.id, cancel });
      toast.success(t('db.sessions.killed'));
      await refresh();
    } catch (err) {
      toast.error(dbErrorMessage(err), t('db.sessions.killFailed'));
    } finally {
      setBusyId(null);
    }
  }, [connectionId, dialect, refresh, t]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <SqlPanelHeader titleKey="db.sessions.title" onClose={onClose} onRefresh={() => void refresh()} loading={loading} />
      <div className="flex-1 min-h-0 overflow-auto p-2 text-xs">
        {error && <p className="text-destructive px-1 py-1">{error}</p>}
        {loading && sessions.length === 0 && (
          <p className="text-muted-foreground px-1 py-1">{t('db.sessions.loading')}</p>
        )}
        {!loading && sessions.length === 0 && (
          <p className="text-muted-foreground px-1 py-1">{t('common.noResultsFound')}</p>
        )}
        {sessions.length > 0 && (
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-muted-foreground">
                <th className="text-left font-normal px-1 py-0.5">ID</th>
                <th className="text-left font-normal px-1 py-0.5">{t('db.sessions.user')}</th>
                <th className="text-left font-normal px-1 py-0.5">{t('db.sessions.client')}</th>
                <th className="text-left font-normal px-1 py-0.5">{t('db.sessions.state')}</th>
                <th className="text-left font-normal px-1 py-0.5">{t('db.sessions.seconds')}</th>
                <th className="text-left font-normal px-1 py-0.5">{t('db.sessions.query')}</th>
                <th className="px-1 py-0.5" />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} className="hover:bg-foreground/5 align-top">
                  <td className="px-1 py-1 font-mono">{s.id}</td>
                  <td className="px-1 py-1 font-mono">{s.user}</td>
                  <td className="px-1 py-1 font-mono truncate max-w-[110px]" title={s.app}>{s.app}</td>
                  <td className="px-1 py-1">{s.state}</td>
                  <td className="px-1 py-1">{s.seconds}</td>
                  <td className="px-1 py-1 font-mono truncate max-w-[220px]" title={s.query}>{s.query}</td>
                  <td className="px-1 py-1 whitespace-nowrap">
                    <button type="button"
                      className="p-0.5 rounded text-muted-foreground hover:text-amber-500 hover:bg-foreground/5 disabled:opacity-40"
                      disabled={busyId === s.id}
                      title={t('db.sessions.cancel')}
                      aria-label={t('db.sessions.cancel')}
                      onClick={() => void kill(s, true)}>
                      <Ban size={12} />
                    </button>
                    <button type="button"
                      className="p-0.5 rounded text-muted-foreground hover:text-destructive hover:bg-foreground/5 disabled:opacity-40 ml-0.5"
                      disabled={busyId === s.id}
                      title={t('db.sessions.terminate')}
                      aria-label={t('db.sessions.terminate')}
                      onClick={() => void kill(s, false)}>
                      <Square size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default SqlSessionsPanel;
