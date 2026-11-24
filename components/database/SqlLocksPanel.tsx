/**
 * Lock management panel (DBeaver locks view): dialect-specific lock query
 * through the existing query channel, generic table render, cancel a holder
 * session via the kill channel. pg/mysql/mssql — the workbench hides the tab
 * for engines without a lock view (registry `features.locks`).
 */
import { Ban } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { SqlEngineId } from '../../domain/models/dbEngines';
import { databaseClient, dbErrorMessage } from '@/infrastructure/services/databaseClient';
import { locksQuery } from './sqlLocks';
import SqlPanelHeader from './SqlPanelHeader';
import { toast } from '../ui/toast';

interface SqlLocksPanelProps {
  connectionId: string;
  dialect: SqlEngineId;
  onClose: () => void;
}

export const SqlLocksPanel: React.FC<SqlLocksPanelProps> = ({ connectionId, dialect, onClose }) => {
  const { t } = useI18n();
  const querySet = locksQuery(dialect);
  const [rows, setRows] = useState<string[][]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyPid, setBusyPid] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!querySet) return;
    setLoading(true);
    setError(null);
    try {
      const res = await databaseClient[dialect].query({ connectionId, sql: querySet.sql });
      const rs = res.resultSets?.[0];
      setColumns((rs?.columns ?? []).map((c) => c.name));
      setRows((rs?.rows ?? []).map((r) => r.map((v) => (v == null ? '' : String(v)))));
    } catch (err) {
      setError(dbErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [connectionId, dialect, querySet]);

  useEffect(() => { void load(); }, [load]);

  const cancelSession = useCallback(async (pid: string) => {
    setBusyPid(pid);
    try {
      await databaseClient[dialect].killSession({ connectionId, pid, cancel: true });
      toast.success(t('db.locks.cancelled'));
      await load();
    } catch (err) {
      toast.error(dbErrorMessage(err), t('db.locks.cancelFailed'));
    } finally {
      setBusyPid(null);
    }
  }, [connectionId, dialect, load, t]);

  if (!querySet) return null;
  // Constant across rows — resolve the session-id column once.
  const pidIdx = columns.indexOf(querySet.pidColumn);

  return (
    <div className="flex flex-col h-full min-h-0">
      <SqlPanelHeader titleKey="db.locks.title" onClose={onClose} onRefresh={() => void load()} loading={loading} />
      <div className="flex-1 min-h-0 overflow-auto p-2 text-xs">
        {error && <p className="text-destructive px-1 py-1">{error}</p>}
        {loading && rows.length === 0 && (
          <p className="text-muted-foreground px-1 py-1">{t('db.overview.loading')}</p>
        )}
        {!loading && !error && rows.length === 0 && (
          <p className="text-muted-foreground px-1 py-1">{t('db.locks.none')}</p>
        )}
        {rows.length > 0 && (
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-muted-foreground">
                {columns.map((c) => (
                  <th key={c} className="text-left font-normal px-1.5 py-0.5">{c}</th>
                ))}
                <th className="px-1.5 py-0.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((cells, i) => {
                const pid = pidIdx >= 0 ? cells[pidIdx] : '';
                return (
                  <tr key={`${i}-${pid}`} className="hover:bg-foreground/5 align-top">
                    {cells.map((cell, j) => (
                      <td key={j} className="px-1.5 py-1 font-mono break-all align-top">{cell}</td>
                    ))}
                    <td className="px-1.5 py-1">
                      {pid && (
                        <button type="button"
                          className="p-0.5 rounded text-muted-foreground hover:text-amber-500 hover:bg-foreground/5 disabled:opacity-40"
                          disabled={busyPid === pid}
                          title={t('db.locks.cancelSession')}
                          aria-label={t('db.locks.cancelSession')}
                          onClick={() => void cancelSession(pid)}>
                          <Ban size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default SqlLocksPanel;
