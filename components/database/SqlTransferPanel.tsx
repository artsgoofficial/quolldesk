/**
 * Cross-connection data transfer (v1: one table at a time): read the source
 * table page-by-page through tableRows, batch INSERT through the target
 * connection's query channel, live progress + cancel. Pure renderer — no new
 * bridge channels. CREATE TABLE is generated from the source column list
 * (best-effort types); an existing target table is reused as-is.
 */
import { ArrowLeft, Loader2, Square } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { sqlQuoteIdent, SQL_ENGINE_BY_ID, type SqlEngineId } from '../../domain/models/dbEngines';
import { databaseClient, dbErrorMessage, resolveDbConnectArgs } from '@/infrastructure/services/databaseClient';
import type { Host } from '../../domain/models/connection';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

const PAGE_SIZE = 500;

interface SqlTransferPanelProps {
  /** Source connection (the one this workbench belongs to). */
  connectionId: string;
  dialect: SqlEngineId;
  sourceTable: string;
  sourceSchema?: string;
  /** All hosts with the same database protocol — target candidates. */
  dbHosts: Host[];
  onOpenData: (table: string, schema?: string) => void;
  onClose: () => void;
}

interface TransferProgress {
  read: number;
  written: number;
  done: boolean;
}

export const SqlTransferPanel: React.FC<SqlTransferPanelProps> = ({
  connectionId, dialect, sourceTable, sourceSchema, dbHosts, onOpenData, onClose,
}) => {
  const { t } = useI18n();
  const [targetConnectionId, setTargetConnectionId] = useState('');
  const [targetSchema, setTargetSchema] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const runIdRef = useRef(0);

  // Same-engine targets only (column types transfer 1:1); cross-engine is a
  // v2. mssql is excluded: its query channel takes named params, not ?/$n.
  const candidates = dbHosts.filter((h) => h.protocol === dialect && h.protocol !== 'mssql');
  const schemaQualified = SQL_ENGINE_BY_ID[dialect].schemaQualified;

  useEffect(() => {
    if (!targetConnectionId && candidates.length > 0) setTargetConnectionId(candidates[0].id);
  }, [candidates.length]);

  const targetRef = databaseClient[dialect];

  const transfer = useCallback(async () => {
    if (!targetConnectionId || running) return;
    const runId = ++runIdRef.current;
    cancelledRef.current = false;
    setRunning(true);
    setError(null);
    setProgress({ read: 0, written: 0, done: false });
    const q = (id: string) => sqlQuoteIdent(dialect, id);
    const destRef = `${targetSchema ? q(targetSchema) + '.' : ''}${q(sourceTable)}`;
    // Target connection is self-managed: dial the chosen host, transfer, hang up.
    const targetHost = candidates.find((h) => h.id === targetConnectionId);
    if (!targetHost) return { fail: 'target host missing' };
    const targetConn = await databaseClient[dialect].connect(resolveDbConnectArgs({ host: targetHost, dialect }));
    const targetId = targetConn.connectionId;
    try {
      // 1. Source shape: columns from tableMeta (source connection).
      const meta = await databaseClient[dialect].tableMeta({ connectionId, table: sourceTable, schema: sourceSchema });
      const colNames = meta.columns.map((c) => c.name);
      if (colNames.length === 0) throw new Error('source table has no columns');

      // 2. Best-effort CREATE TABLE on the target (reuse if it already exists).
      const colsSql = meta.columns
        .map((c) => `${q(c.name)} ${c.type}${c.nullable ? '' : ' NOT NULL'}`)
        .join(', ');
      await targetRef.query({ connectionId: targetId, sql: `CREATE TABLE ${destRef} (${colsSql})`, timeoutMs: 300000 });

      // 3. Page through the source and batch-insert.
      // Parameterized per dialect: pg $1..$n, the rest ? — string values are
      // never interpolated into SQL (injection-safe, escapes preserved).
      const param = (i: number) => (dialect === 'postgresql' ? `$${i + 1}` : '?');
      let offset = 0;
      let written = 0;
      for (;;) {
        if (cancelledRef.current || runIdRef.current !== runId) throw new Error('TRANSFER_CANCELLED');
        const page = await databaseClient[dialect].tableRows({
          connectionId, table: sourceTable, schema: sourceSchema, offset, limit: PAGE_SIZE,
        });
        if (page.rows.length === 0) break;
        // Chunk rows into INSERT batches (multi-row VALUES).
        for (let i = 0; i < page.rows.length; i += 100) {
          if (cancelledRef.current || runIdRef.current !== runId) throw new Error('TRANSFER_CANCELLED');
          const chunk = page.rows.slice(i, i + 100);
          const valuesSql = chunk
            .map((row) => `(${row.map((v) => (v == null ? 'NULL' : param(0))).join(', ')})`)
            .join(', ');
          // One INSERT per row through the parameterized channel: values ride
          // the driver's binding instead of string concatenation.
          for (const row of chunk) {
            const values = row.map((v) => (v == null ? null : String(v)));
            const single = `INSERT INTO ${destRef} (${colNames.map(q).join(', ')}) VALUES (${colNames.map((_, i) => param(i)).join(', ')})`;
            await targetRef.query({ connectionId: targetId, sql: single, values, timeoutMs: 300000 });
            written += 1;
            setProgress({ read: offset + page.rows.length, written, done: false });
          }
        }
        offset += page.rows.length;
        if (page.truncated) break; // server-side cap reached — v1 stops at the cap
      }
      setProgress({ read: written, written, done: true });
    } catch (err) {
      if (String(err?.message || err) !== 'TRANSFER_CANCELLED') setError(dbErrorMessage(err));
      setProgress((prev) => (prev ? { ...prev, done: true } : null));
    } finally {
      void databaseClient[dialect].disconnect(targetId).catch(() => undefined);
      if (runIdRef.current === runId) setRunning(false);
    }
  }, [targetConnectionId, running, dialect, sourceTable, sourceSchema, targetSchema, targetRef]);

  const stop = () => { cancelledRef.current = true; };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-2 py-1.5 border-b border-border/60 flex items-center gap-1.5 shrink-0 app-no-drag">
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onClose} title={t('db.search.back')}>
          <ArrowLeft size={13} />
        </Button>
        <span className="text-xs font-medium">{t('db.transfer.title')}</span>
        <span className="text-xs text-muted-foreground font-mono truncate">{sourceTable}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-3 text-xs space-y-3">
        <p className="text-muted-foreground">{t('db.transfer.hint')}</p>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground shrink-0">{t('db.transfer.targetConnection')}</span>
          <Select value={targetConnectionId} onValueChange={setTargetConnectionId}>
            <SelectTrigger className="h-7 flex-1 min-w-0 text-xs">
              <SelectValue placeholder={t('db.transfer.targetConnection')} />
            </SelectTrigger>
            <SelectContent className="text-xs">
              {candidates.map((h) => (
                <SelectItem key={h.id} value={h.id}>{h.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground shrink-0">{t('db.transfer.targetSchema')}</span>
          {schemaQualified ? (
            <Input className="h-7 flex-1 min-w-0 font-mono" value={targetSchema} autoComplete="off" spellCheck={false}
              placeholder={t('db.transfer.targetSchemaPlaceholder')}
              onChange={(e) => setTargetSchema(e.target.value)} />
          ) : (
            <span className="text-muted-foreground">{t('db.transfer.targetSchemaDefault')}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!running ? (
            <Button size="sm" disabled={!targetConnectionId} onClick={() => void transfer()}>
              {t('db.transfer.run')}
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={stop}>
              <Square size={12} className="mr-1" />{t('db.transfer.stop')}
            </Button>
          )}
          {running && (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 size={12} className="animate-spin" />
              {t('db.transfer.progress', { written: progress?.written ?? 0 })}
            </span>
          )}
        </div>
        {error && <p className="text-destructive break-all">{error}</p>}
        {progress?.done && !running && !error && (
          <p className="text-emerald-600 dark:text-emerald-400">
            {t('db.transfer.done', { written: progress.written })}
          </p>
        )}
        {progress?.done && !running && (
          <Button variant="outline" size="sm" onClick={() => {
            onClose();
            onOpenData(sourceTable, targetSchema || undefined);
          }}>
            {t('db.transfer.openTarget')}
          </Button>
        )}
      </div>
    </div>
  );
};

export default SqlTransferPanel;
