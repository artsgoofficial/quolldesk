import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
// The @/ alias is the repo's sanctioned path for component-layer imports of
// infrastructure services (relative ../../infrastructure imports are eslint-restricted).
import { databaseClient, dbErrorMessage } from '@/infrastructure/services/databaseClient';
import type { SqlEngineId } from '../../domain/models/dbEngines';
import { normalizeHeaderKey, parseCsv } from '../../domain/vaultImport/csvUtils';
import { readXlsxRows } from './xlsxGrid';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';

interface SqlImportWizardProps {
  connectionId: string;
  dialect: SqlEngineId;
  table: string;
  schema?: string;
  columns: string[];
  onClose: () => void;
  /** Fired from the done view's finish button: parent refetches page 0. */
  onImported: () => void;
}

/** Rows per applyTableChanges call (sequential so progress is real). */
const IMPORT_BATCH = 100;
const PREVIEW_ROWS = 10;

/** RFC-4180 parse (shared with vault import) minus entirely blank rows. */
const parseCsvRows = (text: string): string[][] =>
  parseCsv(text).filter((row) => row.some((cell) => cell !== ''));

type WizardStep = 'pick' | 'mapping' | 'importing' | 'done';

// CSV import wizard (SqlTableData toolbar): pick file → map file columns to
// table columns → batched inserts through the existing applyTableChanges
// channel → done. Unmapped file columns are skipped; empty cells become NULL
// or '' per the emptyAsNull toggle.
const SqlImportWizard: React.FC<SqlImportWizardProps> = ({ connectionId, dialect, table, schema, columns, onClose, onImported }) => {
  const { t } = useI18n();
  const client = databaseClient[dialect];
  const [step, setStep] = useState<WizardStep>('pick');
  const [rows, setRows] = useState<string[][]>([]); // parsed CSV rows, header included
  const [fileName, setFileName] = useState('');
  const [mapping, setMapping] = useState<string[]>([]); // file column index → table column ('' = ignored)
  const [skipHeader, setSkipHeader] = useState(true);
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [inserted, setInserted] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Closing the dialog mid-import must stop the remaining batches.
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const dataRows = useMemo(() => (skipHeader ? rows.slice(1) : rows), [rows, skipHeader]);
  // Mapped [table column, file column index] pairs — only these get imported.
  const mappedPairs = useMemo(
    () => mapping.map((col, fileIdx) => ({ col, fileIdx })).filter((pair) => pair.col),
    [mapping],
  );
  // Preview mirrors what startImport will send under the current toggles.
  const previewRows = useMemo(
    () => dataRows.slice(0, PREVIEW_ROWS).map((row) => mappedPairs.map((pair) => {
      const cell = row[pair.fileIdx] ?? '';
      return emptyAsNull && cell === '' ? null : cell;
    })),
    [dataRows, mappedPairs, emptyAsNull],
  );

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      let parsed: string[][];
      if (/\.xlsx$/i.test(file.name)) {
        parsed = await readXlsxRows(await file.arrayBuffer());
      } else {
        let text = await file.text();
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip UTF-8 BOM
        parsed = parseCsvRows(text);
      }
      if (parsed.length === 0) throw new Error('CSV: no rows found');
      const header = parsed[0];
      // Auto-match by exact name first, then normalized (shared vault-import
      // header key: case/whitespace/underscore/punctuation-insensitive).
      const auto = header.map((name) => {
        const exact = columns.find((c) => c === name);
        if (exact) return exact;
        const norm = normalizeHeaderKey(name);
        return columns.find((c) => normalizeHeaderKey(c) === norm) ?? '';
      });
      const headerMatches = header.some((name) => columns.some((c) => c === name || normalizeHeaderKey(c) === normalizeHeaderKey(name)));
      setRows(parsed);
      setMapping(auto);
      setSkipHeader(headerMatches);
      setFileName(file.name);
      setProgress({ done: 0, total: 0 });
      setInserted(0);
      setStep('mapping');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const startImport = async () => {
    if (mappedPairs.length === 0 || dataRows.length === 0) return;
    setStep('importing');
    setError(null);
    const total = dataRows.length;
    setProgress({ done: 0, total });
    let done = 0;
    try {
      for (let start = 0; start < total; start += IMPORT_BATCH) {
        if (!aliveRef.current) return; // dialog closed: stop remaining batches
        const batch = dataRows.slice(start, start + IMPORT_BATCH).map((row) => {
          const values: Record<string, string | null> = {};
          for (const pair of mappedPairs) {
            const cell = row[pair.fileIdx] ?? '';
            values[pair.col] = emptyAsNull && cell === '' ? null : cell;
          }
          return { values };
        });
        await client.applyTableChanges({ connectionId, table, schema, changes: { inserts: batch } });
        done += batch.length;
        setProgress({ done, total });
      }
      if (!aliveRef.current) return;
      setInserted(done);
      setStep('done');
    } catch (err) {
      if (aliveRef.current) setError(dbErrorMessage(err));
    }
  };

  const fileColumnLabel = (index: number): string => rows[0]?.[index]?.trim() || `#${index + 1}`;
  const columnCount = rows[0]?.length ?? 0;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{t('db.grid.importCsv')}</DialogTitle>
          <p className="text-xs text-muted-foreground break-all">
            {schema ? `${schema}.${table}` : table}
            {fileName ? ` · ${fileName}` : ''}
          </p>
        </DialogHeader>

        {step === 'pick' && (
          <div className="flex flex-col gap-3 text-xs">
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">{t('db.import.pickFile')}</span>
              <input
                type="file"
                accept=".csv,.xlsx"
                className="rounded border border-border bg-background px-2 py-1.5 file:mr-2 file:rounded file:border-0 file:bg-foreground/10 file:px-2 file:py-0.5 file:text-xs"
                onChange={(e) => { void handleFile(e.target.files?.[0]); e.target.value = ''; }}
              />
            </label>
            {error && <p className="text-destructive break-all">{error}</p>}
          </div>
        )}

        {step === 'mapping' && (
          <div className="flex flex-col gap-3 text-xs min-h-0">
            <p className="text-muted-foreground">
              {t('db.import.mapping')} · {rows.length} × {columnCount}
            </p>
            <div className="max-h-40 overflow-auto rounded border border-border/40 divide-y divide-border/30">
              {rows[0]?.map((name, i) => (
                <div key={`map:${i}`} className="flex items-center gap-2 px-2 py-1">
                  <span className="w-32 shrink-0 truncate font-mono text-muted-foreground" title={name}>{fileColumnLabel(i)}</span>
                  <span className="text-muted-foreground">→</span>
                  <select
                    className="h-6 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs"
                    aria-label={fileColumnLabel(i)}
                    value={mapping[i] ?? ''}
                    onChange={(e) => setMapping((prev) => prev.map((m, idx) => (idx === i ? e.target.value : m)))}>
                    <option value="">{t('db.import.ignoreColumn')}</option>
                    {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={skipHeader} onChange={(e) => setSkipHeader(e.target.checked)} />
                {t('db.import.skipHeader')}
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={emptyAsNull} onChange={(e) => setEmptyAsNull(e.target.checked)} />
                {t('db.import.emptyAsNull')}
              </label>
            </div>
            <div className="min-h-0">
              <p className="text-muted-foreground mb-1">{t('db.import.preview')}</p>
              <div className="max-h-48 overflow-auto rounded border border-border/40">
                <table className="w-full border-collapse text-xs">
                  <thead className="sticky top-0 bg-background">
                    <tr className="border-b border-border/60">
                      {mappedPairs.map((pair) => (
                        <th key={pair.col} className="px-2 py-1 text-left font-medium">{pair.col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((row, ri) => (
                      <tr key={`preview:${ri}`} className="border-b border-border/30">
                        {row.map((cell, ci) => (
                          <td key={ci} className="px-2 py-1 font-mono break-all max-w-[180px]">
                            {cell == null ? <span className="text-muted-foreground italic">NULL</span> : cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {error && <p className="text-destructive break-all">{error}</p>}
          </div>
        )}

        {step === 'importing' && (
          <div className="flex flex-col gap-2 text-xs">
            <p>{t('db.import.progress', { done: progress.done, total: progress.total })}</p>
            <div className="h-1.5 rounded bg-muted overflow-hidden">
              <div className="h-full bg-sky-500 transition-all" style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
            </div>
            {error && <p className="text-destructive break-all">{error}</p>}
          </div>
        )}

        {step === 'done' && (
          <p className="text-xs text-emerald-600 dark:text-emerald-400">{t('db.import.done', { count: inserted })}</p>
        )}

        <DialogFooter>
          {step === 'mapping' && (
            <>
              <Button variant="outline" size="sm" onClick={onClose}>{t('db.action.cancel')}</Button>
              <Button size="sm" className="font-medium" disabled={mappedPairs.length === 0 || dataRows.length === 0} onClick={() => void startImport()}>
                {t('db.import.start')}
              </Button>
            </>
          )}
          {step === 'done' && (
            <Button size="sm" onClick={() => { onImported(); onClose(); }}>{t('db.action.close')}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default SqlImportWizard;
