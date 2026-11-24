import React, { useEffect, useRef, useState } from 'react';
import { Database, Upload, X } from 'lucide-react';
import { useI18n } from '../../application/i18n/I18nProvider';
// The @/ alias is the repo's sanctioned path for component-layer imports of
// infrastructure services (relative ../../infrastructure imports are eslint-restricted).
import { databaseClient, dbErrorMessage } from '@/infrastructure/services/databaseClient';
import type { DbJobProgress } from '../../types/global/quolldesk-bridge-database';
import type { SqlEngineId } from '../../domain/models/dbEngines';
import { Button } from '../ui/button';

interface SqlBackupRestoreProps {
  connectionId: string;
  dialect: SqlEngineId;
  /** Currently selected table in the workbench; 当前表 scope is disabled without it. */
  table?: string;
  /** pg schema of `table` (defaults to public on the bridge). */
  schema?: string;
  /** Database name for the default file name (<db>_<scope>_YYYYMMDD.sql). */
  dbName?: string;
  onClose: () => void;
}

interface BackupProgress { table?: string; rowsDone?: number; tablesDone?: number; tablesTotal?: number }
interface RestoreProgress { done: number; total: number }

const pad2 = (n: number): string => String(n).padStart(2, '0');
const dateStamp = (d: Date): string => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;

/**
 * SQL backup/restore full-area view (workbench toolbar [备份/还原]).
 * Backup streams a plain SQL dump chosen via the native save dialog; progress
 * arrives as quolldesk:db:jobProgress pushes for the jobId returned by the
 * invoke. Restore splits the chosen file into statements in the main process
 * and executes them sequentially; a failed statement reports its index and
 * stops (earlier statements stay applied).
 */
const SqlBackupRestore: React.FC<SqlBackupRestoreProps> = ({ connectionId, dialect, table, schema, dbName, onClose }) => {
  const { t } = useI18n();
  const client = databaseClient[dialect];

  // ---- backup state ----
  const [scope, setScope] = useState<'database' | 'table'>('database');
  const [includeData, setIncludeData] = useState(true);
  const [backingUp, setBackingUp] = useState(false);
  const [backupProgress, setBackupProgress] = useState<BackupProgress | null>(null);
  const [backupOutFile, setBackupOutFile] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const backupJobRef = useRef<string | null>(null);

  // ---- restore state ----
  const [restoreFile, setRestoreFile] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState<RestoreProgress | null>(null);
  const [restoreDone, setRestoreDone] = useState<number | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const restoreJobRef = useRef<string | null>(null);
  // Latest restore progress for the done-push fallback (executed count).
  const restoreProgressRef = useRef<RestoreProgress | null>(null);

  // Single shared push channel; payload.jobId routes events to backup or
  // restore state. Unsubscribes on unmount.
  useEffect(() => {
    const unsubscribe = client.onJobProgress((payload: DbJobProgress) => {
      if (!payload?.jobId) return;
      if (payload.jobId === backupJobRef.current) {
        if (payload.phase === 'done') {
          backupJobRef.current = null;
          setBackingUp(false);
          setBackupProgress(null);
        } else if (payload.phase === 'error') {
          backupJobRef.current = null;
          setBackingUp(false);
          setBackupError(payload.error || payload.message || 'backup failed');
        } else {
          setBackupProgress({ table: payload.table, rowsDone: payload.rowsDone, tablesDone: payload.tablesDone, tablesTotal: payload.tablesTotal });
        }
      } else if (payload.jobId === restoreJobRef.current) {
        if (payload.phase === 'done') {
          restoreJobRef.current = null;
          setRestoring(false);
          setRestoreProgress(null);
          const executed = Number(payload.message?.match(/^(\d+) statements executed$/)?.[1]);
          setRestoreDone(Number.isFinite(executed) ? executed : (restoreProgressRef.current?.done ?? 0));
        } else if (payload.phase === 'error') {
          restoreJobRef.current = null;
          setRestoring(false);
          const at = payload.index != null ? `#${payload.index + 1} ` : '';
          setRestoreError(`${at}${payload.error || payload.message || 'restore failed'}`);
        } else if (payload.phase === 'restore') {
          restoreProgressRef.current = { done: Number(payload.done ?? 0), total: Number(payload.total ?? 0) };
          setRestoreProgress(restoreProgressRef.current);
        }
      }
    });
    return unsubscribe;
  }, [client, connectionId]);

  const startBackup = async () => {
    if (backingUp || restoring) return;
    setBackupError(null);
    setBackupOutFile(null);
    setBackupProgress(null);
    try {
      // dbName arrives via dbHostDatabaseName (file-backed engines already
      // reduced to the bare file name), so it names the dump directly.
      const defaultName = `${dbName || 'db'}_${scope}_${dateStamp(new Date())}.sql`;
      const picked = await client.pickBackupPath(defaultName);
      if (!picked.path) return; // dialog cancelled
      setBackupOutFile(picked.path);
      setBackingUp(true);
      const { jobId } = await client.backup({
        connectionId,
        scope,
        table: scope === 'table' ? table : undefined,
        schema,
        includeData,
        outFile: picked.path,
      });
      backupJobRef.current = jobId;
    } catch (err) {
      setBackingUp(false);
      const message = dbErrorMessage(err);
      setBackupError(message === 'backup already in progress' ? t('db.backup.active') : message);
    }
  };

  const pickRestoreFile = async () => {
    if (restoring) return;
    setRestoreError(null);
    setRestoreDone(null);
    try {
      const picked = await client.pickRestoreFile();
      if (picked.path) setRestoreFile(picked.path);
    } catch (err) {
      setRestoreError(dbErrorMessage(err));
    }
  };

  const startRestore = async () => {
    if (!restoreFile || backingUp || restoring) return;
    setRestoreError(null);
    setRestoreDone(null);
    setRestoreProgress(null);
    restoreProgressRef.current = null;
    try {
      setRestoring(true);
      const { jobId } = await client.restore({ connectionId, inFile: restoreFile });
      restoreJobRef.current = jobId;
    } catch (err) {
      setRestoring(false);
      const message = dbErrorMessage(err);
      setRestoreError(message === 'restore already in progress' ? t('db.backup.active') : message);
    }
  };

  const backupPct = backupProgress?.tablesTotal
    ? Math.round(((backupProgress.tablesDone ?? 0) / backupProgress.tablesTotal) * 100)
    : null;
  const tableScopeDisabled = !table;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2 border-b border-border/60 flex items-center gap-2 shrink-0 app-no-drag">
        <Database size={14} className="text-muted-foreground" />
        <span className="text-sm font-medium">{t('db.backup.title')}</span>
        <div className="ml-auto">
          <button type="button" className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-foreground/5"
            title={t('db.action.close')} onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-6 text-xs max-w-[640px] mx-auto">
        {/* ---- 备份 ---- */}
        <section className="space-y-3">
          <h3 className="text-sm font-medium">{t('db.backup.section')}</h3>
          <div className="flex flex-col gap-1.5">
            <label className={`flex items-center gap-2 ${tableScopeDisabled ? 'opacity-60' : ''}`}>
              <input type="radio" name="nc-backup-scope" checked={scope === 'database'}
                disabled={backingUp} onChange={() => setScope('database')} />
              <span>{t('db.backup.scope.database')}</span>
            </label>
            <label className={`flex items-center gap-2 ${tableScopeDisabled ? 'opacity-60' : ''}`}>
              <input type="radio" name="nc-backup-scope" checked={scope === 'table'}
                disabled={backingUp || tableScopeDisabled} onChange={() => setScope('table')} />
              <span>
                {t('db.backup.scope.table')}
                {table && <span className="ml-1 font-mono text-muted-foreground">{table}</span>}
              </span>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={includeData} disabled={backingUp}
                onChange={(e) => setIncludeData(e.target.checked)} />
              <span>{t('db.backup.includeData')}</span>
            </label>
          </div>
          <div>
            <Button size="sm" disabled={backingUp || restoring || (scope === 'table' && tableScopeDisabled)}
              onClick={() => void startBackup()}>
              <Upload size={13} className="mr-1" />{t('db.backup.pickPath')}
            </Button>
          </div>
          {backingUp && (
            <div className="space-y-1">
              <p className="text-muted-foreground">
                {t('db.backup.inProgress')}
                {backupProgress?.table && (
                  <span className="ml-1 font-mono">
                    {backupProgress.table}{backupProgress.rowsDone != null ? ` · ${backupProgress.rowsDone}` : ''}
                  </span>
                )}
              </p>
              <div className="h-1.5 rounded bg-muted overflow-hidden">
                <div className="h-full bg-primary transition-all"
                  style={{ width: `${backupPct == null ? 15 : Math.max(3, backupPct)}%` }} />
              </div>
            </div>
          )}
          {backupOutFile && !backingUp && !backupError && (
            <p className="text-emerald-600 dark:text-emerald-400 break-all">
              {t('db.backup.done')}: <span className="font-mono">{backupOutFile}</span>
            </p>
          )}
          {backupError && <p className="text-destructive break-all">{backupError}</p>}
        </section>

        {/* ---- 还原 ---- */}
        <section className="space-y-3">
          <h3 className="text-sm font-medium">{t('db.restore.section')}</h3>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={backingUp || restoring} onClick={() => void pickRestoreFile()}>
              {t('db.backup.restoreFile')}
            </Button>
            {restoreFile && <span className="font-mono text-muted-foreground truncate" title={restoreFile}>{restoreFile}</span>}
          </div>
          <div>
            <Button size="sm" disabled={!restoreFile || backingUp || restoring} onClick={() => void startRestore()}>
              {t('db.backup.startRestore')}
            </Button>
          </div>
          {restoring && restoreProgress && (
            <div className="space-y-1">
              <p className="text-muted-foreground">{restoreProgress.done}/{restoreProgress.total}</p>
              <div className="h-1.5 rounded bg-muted overflow-hidden">
                <div className="h-full bg-primary transition-all"
                  style={{ width: `${restoreProgress.total ? Math.max(3, Math.round((restoreProgress.done / restoreProgress.total) * 100)) : 3}%` }} />
              </div>
            </div>
          )}
          {restoreDone != null && !restoring && !restoreError && (
            <p className="text-emerald-600 dark:text-emerald-400">{t('db.restore.done', { count: restoreDone })}</p>
          )}
          {restoreError && (
            <p className="text-destructive break-all">
              <span className="font-medium">{t('db.restore.failed')}: </span>{restoreError}
            </p>
          )}
        </section>
      </div>
    </div>
  );
};

export default SqlBackupRestore;
