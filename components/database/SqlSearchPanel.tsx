/**
 * Database-wide search panel (DBeaver-style DB search): object names
 * (tables/views/columns) always; data content optionally — one parameterized
 * probe SELECT per table over its text-like columns. Pure renderer: runs on
 * the existing schemaTree/tableMeta/query channels, zero new IPC.
 */
import { ArrowLeft, Loader2, Search, Square, Table2 } from 'lucide-react';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { sqlQuoteIdent, type SqlEngineId } from '../../domain/models/dbEngines';
import { databaseClient, dbErrorMessage } from '@/infrastructure/services/databaseClient';
import { fetchSqlSchemaTree } from '@/infrastructure/services/sqlSchemaTreeCache';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  buildProbeSql, matchesTerm, textLikeColumns, type SqlSearchHit,
} from './sqlSearch';
import { buildSchemaJobs } from './sqlSchemaJobs';

/** Hard caps so a huge database cannot hang the panel. */
const MAX_TABLES = 200;
const PROBE_ROWS = 3;

interface SqlSearchPanelProps {
  connectionId: string;
  dialect: SqlEngineId;
  /** Schema/database to scope the search to; empty = search everything. */
  selectedSchema?: string;
  onOpenData: (table: string, schema?: string) => void;
  onClose: () => void;
}

export const SqlSearchPanel: React.FC<SqlSearchPanelProps> = ({
  connectionId, dialect, selectedSchema, onOpenData, onClose,
}) => {
  const { t } = useI18n();
  const client = databaseClient[dialect];
  const [term, setTerm] = useState('');
  const [withData, setWithData] = useState(false);
  const [running, setRunning] = useState(false);
  const [hits, setHits] = useState<SqlSearchHit[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const runIdRef = useRef(0);

  const canRun = term.trim().length > 0 && !running;

  const runSearch = useCallback(async () => {
    const trimmed = term.trim();
    if (!trimmed || running) return;
    const runId = ++runIdRef.current;
    cancelledRef.current = false;
    setRunning(true);
    setHits([]);
    setError(null);
    setProgress({ done: 0, total: 0 });
    try {
      const tree = await fetchSqlSchemaTree(dialect, connectionId);
      // Views participate in object-name matching only (data probe v1 = tables),
      // so the probe-eligible set comes from the tables-only pass.
      const tablesOnly = new Set(
        buildSchemaJobs(dialect, tree.databases, selectedSchema).map((j) => `${j.schema ?? ''}.${j.table}`),
      );
      const jobs = buildSchemaJobs(dialect, tree.databases, selectedSchema, { includeViews: true });
      const capped = jobs.slice(0, MAX_TABLES);
      setProgress({ done: 0, total: capped.length });
      const scanned: SqlSearchHit[] = [];
      for (const job of capped) {
        if (cancelledRef.current || runIdRef.current !== runId) break;
        const hit: SqlSearchHit = {
          schema: job.schema, table: job.table,
          nameHit: matchesTerm(job.table, trimmed),
          matchedColumnNames: [], dataHit: false, sampleRows: [],
        };
        if (tablesOnly.has(`${job.schema ?? ''}.${job.table}`)) {
          try {
            const meta = await client.tableMeta({ connectionId, table: job.table, schema: job.schema ?? undefined });
            if (cancelledRef.current || runIdRef.current !== runId) break;
            const textCols = textLikeColumns(meta.columns, dialect).map((c) => c.name);
            hit.matchedColumnNames = textCols.filter((c) => matchesTerm(c, trimmed));
            if (withData && textCols.length > 0) {
              const tableRef = job.schema ? `${sqlQuoteIdent(dialect, job.schema)}.${sqlQuoteIdent(dialect, job.table)}` : sqlQuoteIdent(dialect, job.table);
              const probe = buildProbeSql(dialect, tableRef, textCols, trimmed, PROBE_ROWS);
              if (probe) {
                const res = await client.query({ connectionId, sql: probe.sql, values: probe.values });
                const rows = res.resultSets?.[0]?.rows ?? [];
                if (rows.length > 0) { hit.dataHit = true; hit.sampleRows = rows; }
              }
            }
          } catch { /* per-table failures (permissions, dropped mid-scan) skip the table */ }
        }
        scanned.push(hit);
        setHits([...scanned]);
        setProgress({ done: scanned.length, total: capped.length });
      }
      setHits(scanned.filter((h) => h.nameHit || h.matchedColumnNames.length > 0 || h.dataHit));
    } catch (err) {
      setError(dbErrorMessage(err));
    } finally {
      if (runIdRef.current === runId) setRunning(false);
    }
  }, [term, running, dialect, connectionId, selectedSchema, withData, client]);

  const visible = useMemo(
    () => (running ? hits.filter((h) => h.nameHit || h.matchedColumnNames.length > 0 || h.dataHit) : hits),
    [running, hits],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-2 py-1.5 border-b border-border/60 flex items-center gap-1.5 shrink-0 app-no-drag">
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onClose} title={t('db.search.back')}>
          <ArrowLeft size={13} />
        </Button>
        <Input className="h-7 flex-1 min-w-0 font-mono text-xs" value={term} autoComplete="off" spellCheck={false}
          placeholder={t('db.search.termPlaceholder')}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }} />
        <label className="flex items-center gap-1 text-xs text-muted-foreground shrink-0"
          title={t('db.search.dataScopeHint')}>
          <input type="checkbox" checked={withData} onChange={(e) => setWithData(e.target.checked)} />
          {t('db.search.scopeData')}
        </label>
        {running ? (
          <Button variant="outline" size="sm" className="h-7" onClick={() => { cancelledRef.current = true; }}>
            <Square size={12} className="mr-1" />{t('db.search.stop')}
          </Button>
        ) : (
          <Button size="sm" className="h-7" disabled={!canRun} onClick={() => void runSearch()}>
            <Search size={12} className="mr-1" />{t('db.search.run')}
          </Button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-2 text-xs">
        {error && <p className="text-destructive px-1 py-1">{error}</p>}
        {running && (
          <p className="flex items-center gap-1.5 text-muted-foreground px-1 py-1">
            <Loader2 size={12} className="animate-spin" />
            {t('db.search.progress', { done: progress.done, total: progress.total })}
          </p>
        )}
        {!running && !error && visible.length === 0 && progress.total > 0 && (
          <p className="text-muted-foreground px-1 py-1">{t('db.search.noResults')}</p>
        )}
        {visible.map((hit) => (
          <button key={`${hit.schema ?? ''}.${hit.table}`} type="button"
            className="block w-full text-left px-1.5 py-1 rounded hover:bg-foreground/5"
            onClick={() => onOpenData(hit.table, hit.schema ?? undefined)}>
            <span className="flex items-center gap-1.5">
              <Table2 size={12} className="text-muted-foreground shrink-0" />
              <span className="font-mono truncate">
                {hit.schema ? `${hit.schema}.` : ''}{hit.table}
              </span>
              {hit.nameHit && <span className="text-[10px] rounded bg-foreground/10 px-1">{t('db.search.nameHit')}</span>}
              {hit.dataHit && <span className="text-[10px] rounded bg-emerald-600/15 text-emerald-700 dark:text-emerald-400 px-1">{t('db.search.dataHit')}</span>}
            </span>
            {hit.matchedColumnNames.length > 0 && (
              <span className="block pl-5 text-[11px] text-muted-foreground truncate font-mono">
                {hit.matchedColumnNames.join(', ')}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
};

export default SqlSearchPanel;
