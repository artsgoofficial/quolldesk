import { ArrowDown, ArrowUp, ArrowUpRight, Check, ChevronLeft, ChevronRight, Download, Plus, RotateCcw, Trash2, Upload, X } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
// The @/ alias is the repo's sanctioned path for component-layer imports of
// infrastructure services (relative ../../infrastructure imports are eslint-restricted).
import { databaseClient, dbErrorMessage } from '@/infrastructure/services/databaseClient';
import type { DbGridFilter, DbPendingUpdate, SqlForeignKeyMeta } from '@/types/global/quolldesk-bridge-database';
import { toast } from '../ui/toast';
import { Button } from '../ui/button';
import { downloadCsv, downloadInserts, downloadJson } from './csv';
import SqlImportWizard from './SqlImportWizard';

interface SqlTableDataProps {
  connectionId: string;
  dialect: 'mysql' | 'postgresql';
  table: string | null;
  schema?: string;
  refreshToken?: number;
  /** FK jump-through seed: applied as an eq filter after the target's meta loads. */
  jumpFilter?: { column: string; value: string } | null;
  /** Bumped by the workbench on every FK navigation; detects fresh vs stale jumpFilter. */
  jumpCounter?: number;
  /** Present for SQL workbench grids: navigating to the referenced table's row. */
  onNavigateForeignKey?: (target: { table: string; schema?: string; column: string; value: string }) => void;
}

const PAGE_SIZE = 100;
const MAX_FILTERS = 10;

type GridSortDir = 'asc' | 'desc';
type ExportFormat = 'csv' | 'json' | 'inserts';

// Locale-neutral operator labels (comparison symbols render in every language).
const FILTER_OPS: { value: DbGridFilter['op']; label: string }[] = [
  { value: 'eq', label: '=' },
  { value: 'ne', label: '≠' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'like', label: 'LIKE' },
  { value: 'nul', label: 'IS NULL' },
  { value: 'nnul', label: 'IS NOT NULL' },
];
const filterOpLabel = (op: string) => FILTER_OPS.find((o) => o.value === op)?.label ?? op;

type PendingUpdate = DbPendingUpdate;
interface PendingInsert { id: string; values: Record<string, string | null> }
interface EditingCell { rowKey: string; column: string; value: string; isNull: boolean }
interface GridSelection { rowKey: string; column: string | null }

const cellKey = (pkValue: string, column: string) => `${pkValue}\u0000${column}`;

const SqlTableData: React.FC<SqlTableDataProps> = ({ connectionId, dialect, table, schema, refreshToken, jumpFilter, jumpCounter = 0, onNavigateForeignKey }) => {
  const { t } = useI18n();
  const [columns, setColumns] = useState<{ name: string }[]>([]);
  const [rows, setRows] = useState<unknown[][]>([]);
  const [offset, setOffset] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [orderBy, setOrderBy] = useState<string | undefined>(undefined);
  const [orderDir, setOrderDir] = useState<GridSortDir | undefined>(undefined);
  const [filters, setFilters] = useState<DbGridFilter[]>([]);
  const [filterColumn, setFilterColumn] = useState('');
  const [filterOp, setFilterOp] = useState<DbGridFilter['op']>('eq');
  const [filterValue, setFilterValue] = useState('');
  const [exportFormat, setExportFormat] = useState<ExportFormat>('csv');
  const [selected, setSelected] = useState<GridSelection | null>(null);
  const [pkColumn, setPkColumn] = useState<string | null>(null);
  const [foreignKeys, setForeignKeys] = useState<SqlForeignKeyMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Pending grid edits (Navicat-style: staged locally, applied transactionally).
  const [pendingUpdates, setPendingUpdates] = useState<Record<string, PendingUpdate>>({});
  const [pendingDeletes, setPendingDeletes] = useState<Set<string>>(new Set());
  const [pendingInserts, setPendingInserts] = useState<PendingInsert[]>([]);
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const [applying, setApplying] = useState(false);
  // CSV import wizard (editable tables only): parent refetches page 0 on finish.
  const [importOpen, setImportOpen] = useState(false);
  const client = databaseClient[dialect];

  const fetchPage = async (nextOffset: number, orderByColumn: string | undefined, dir?: GridSortDir, activeFilters?: DbGridFilter[]) => {
    if (!table) return;
    setLoading(true); setError(null);
    try {
      const page = await client.tableRows({ connectionId, table, schema, orderBy: orderByColumn, orderDir: dir, filters: activeFilters, offset: Math.max(0, nextOffset), limit: PAGE_SIZE });
      setRows(page.rows); setTruncated(page.truncated); setOffset(Math.max(0, nextOffset));
    } catch (err) {
      setError(dbErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  // Last applied FK jump (by counter): stale jumpFilter values must not re-seed
  // the grid on unrelated re-runs (refresh token, reconnect).
  const appliedJumpRef = useRef(0);

  useEffect(() => {
    if (!table) { setColumns([]); setRows([]); setEstimate(null); setPkColumn(null); setForeignKeys([]); setPendingUpdates({}); setPendingDeletes(new Set()); setPendingInserts([]); setEditing(null); setSelected(null); setFilters([]); return; }
    // FK jump-through: the workbench bumps jumpCounter on every navigation; a
    // fresh counter seeds the grid filter with the jump target (chip renders
    // immediately, the page-0 fetch below carries it) instead of clearing it.
    const isJump = jumpFilter != null && jumpCounter !== appliedJumpRef.current;
    if (isJump) appliedJumpRef.current = jumpCounter;
    const seedFilters: DbGridFilter[] = isJump && jumpFilter ? [{ column: jumpFilter.column, op: 'eq', value: jumpFilter.value }] : [];
    let alive = true;
    setLoading(true); setError(null); setOffset(0);
    setPendingUpdates({}); setPendingDeletes(new Set()); setPendingInserts([]); setEditing(null);
    setSelected(null);
    setOrderDir(undefined); setFilters(seedFilters); setFilterColumn(''); setFilterOp('eq'); setFilterValue('');
    (async () => {
      try {
        const meta = await client.tableMeta({ connectionId, table, schema });
        if (!alive) return;
        // Primary key for row identity: the bridge reports it (PRI flags plus
        // the ordered primaryKey payload) — no renderer-side DDL parsing.
        const pk: string | null = meta.primaryKey?.columns[0] ?? meta.columns.find((c) => c.key === 'PRI')?.name ?? null;
        setPkColumn(pk);
        setOrderBy(pk ?? meta.columns[0]?.name);
        setColumns(meta.columns.map((c) => ({ name: c.name })));
        setForeignKeys(meta.foreignKeys ?? []);
        setEstimate(meta.rowCountEstimate);
        const page = await client.tableRows({ connectionId, table, schema, orderBy: pk ?? meta.columns[0]?.name, filters: seedFilters.length ? seedFilters : undefined, offset: 0, limit: PAGE_SIZE });
        if (!alive) return;
        setRows(page.rows);
        setTruncated(page.truncated);
      } catch (err) {
        if (alive) setError(dbErrorMessage(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [connectionId, client, table, schema, refreshToken, jumpCounter, jumpFilter]);

  // Column → foreign key lookup for the jump-through affordance.
  const fkByColumn = useMemo(() => {
    const map = new Map<string, SqlForeignKeyMeta>();
    for (const fk of foreignKeys) map.set(fk.column, fk);
    return map;
  }, [foreignKeys]);

  const startEdit = (rowKey: string, column: string, current: unknown) => {
    if (!pkColumn) return;
    setEditing({ rowKey, column, value: current == null ? '' : String(current), isNull: current == null });
  };

  const commitEdit = () => {
    if (!editing || !pkColumn) { setEditing(null); return; }
    const { rowKey, column, value, isNull } = editing;
    const nextValue = isNull ? null : value;
    setEditing(null);
    if (rowKey.startsWith('ins:')) {
      const id = rowKey.slice(4);
      setPendingInserts((prev) => prev.map((ins) => (ins.id === id ? { ...ins, values: { ...ins.values, [column]: nextValue } } : ins)));
      return;
    }
    const key = cellKey(rowKey, column);
    setPendingUpdates((prev) => {
      const next = { ...prev };
      next[key] = { pk: pkColumn, pkValue: rowKey, column, value: nextValue };
      return next;
    });
  };

  const addRow = () => {
    if (!pkColumn) return;
    const values: Record<string, string | null> = {};
    for (const c of columns) values[c.name] = null;
    setPendingInserts((prev) => [...prev, { id: `ins:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, values }]);
  };

  const markDeleteRow = (rowKey: string) => {
    if (rowKey.startsWith('ins:')) {
      const id = rowKey.slice(4);
      setPendingInserts((prev) => prev.filter((ins) => ins.id !== id));
      return;
    }
    setPendingDeletes((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else {
        next.add(rowKey);
        // Row is being deleted: drop its staged cell edits.
        setPendingUpdates((prevUpdates) => {
          const nextUpdates: Record<string, PendingUpdate> = {};
          for (const [key, entry] of Object.entries(prevUpdates)) {
            if (entry.pkValue !== rowKey) nextUpdates[key] = entry;
          }
          return nextUpdates;
        });
      }
      return next;
    });
  };

  const revertAll = () => {
    setPendingUpdates({}); setPendingDeletes(new Set()); setPendingInserts([]); setEditing(null);
  };

  // Single active sort: clicking a header cycles asc → desc → none. "None"
  // reverts to the default (pk) ordering so pagination stays deterministic.
  // Sort/filter changes only move the page offset — staged edits are keyed by
  // pk value and intentionally survive them.
  const defaultOrderColumn = pkColumn ?? columns[0]?.name;
  const toggleSort = (column: string) => {
    const nextDir: GridSortDir | undefined = orderBy === column
      ? (orderDir === 'asc' ? 'desc' : orderDir === 'desc' ? undefined : 'asc')
      : 'asc';
    const effectiveColumn = nextDir === undefined ? defaultOrderColumn : column;
    setOrderBy(effectiveColumn);
    setOrderDir(nextDir);
    setOffset(0);
    void fetchPage(0, effectiveColumn, nextDir, filters);
  };

  const refetchWithFilters = (nextFilters: DbGridFilter[]) => {
    setFilters(nextFilters);
    setOffset(0);
    void fetchPage(0, orderBy, orderDir, nextFilters);
  };

  const applyFilter = () => {
    if (!filterColumn || filters.length >= MAX_FILTERS) return;
    const needsValue = filterOp !== 'nul' && filterOp !== 'nnul';
    const next: DbGridFilter = needsValue
      ? { column: filterColumn, op: filterOp, value: filterValue }
      : { column: filterColumn, op: filterOp };
    refetchWithFilters([...filters, next]);
    setFilterValue('');
  };

  const removeFilter = (index: number) => refetchWithFilters(filters.filter((_, i) => i !== index));
  const clearFilters = () => refetchWithFilters([]);

  const pendingCount = Object.keys(pendingUpdates).length + pendingDeletes.size + pendingInserts.length;

  const applyChanges = async () => {
    if (!table || !pkColumn || pendingCount === 0 || applying) return;
    for (const ins of pendingInserts) {
      if (ins.values[pkColumn] == null || ins.values[pkColumn] === '') {
        toast.error(t('db.grid.pkRequired'), t('db.grid.apply'));
        return;
      }
    }
    setApplying(true); setError(null);
    try {
      const result = await client.applyTableChanges({
        connectionId,
        table,
        schema,
        changes: {
          updates: Object.values(pendingUpdates),
          inserts: pendingInserts.map((ins) => ({ values: ins.values })),
          deletes: [...pendingDeletes].map((pkValue) => ({ pk: pkColumn, pkValue })),
        },
      });
      const total = result.applied.updates + result.applied.inserts + result.applied.deletes;
      toast.success(t('db.grid.applied', { count: total }), t('db.grid.apply'));
      revertAll();
      await fetchPage(offset, orderBy, orderDir, filters);
    } catch (err) {
      toast.error(dbErrorMessage(err), t('db.grid.apply'));
    } finally {
      setApplying(false);
    }
  };

  const exportData = () => {
    if (!table) return;
    const base = `${schema ? `${schema}.` : ''}${table}`;
    const columnNames = columns.map((c) => c.name);
    // Export the derived view (staged edits included) as raw cell values.
    const cellRows = displayRows.map((r) => r.cells.map((cell) => cell.value));
    if (exportFormat === 'json') downloadJson(`${base}.json`, columnNames, cellRows);
    else if (exportFormat === 'inserts') downloadInserts(`${base}.sql`, base, columnNames, cellRows);
    else downloadCsv(`${base}.csv`, columnNames, cellRows);
  };

  // Derived view: server rows (minus staged deletes, with staged edits) + staged inserts.
  const displayRows = useMemo(() => {
    const cellValue = (pkValue: string, index: number, base: unknown): { value: unknown; edited: boolean } => {
      const colName = columns[index]?.name;
      const staged = colName ? pendingUpdates[cellKey(pkValue, colName)] : undefined;
      if (staged) return { value: staged.value, edited: true };
      return { value: base, edited: false };
    };
    const server = rows
      .map((row) => ({ row, pkValue: pkColumn && row[columns.findIndex((c) => c.name === pkColumn)] != null ? String(row[columns.findIndex((c) => c.name === pkColumn)]) : String(rows.indexOf(row)) }))
      .filter(({ pkValue }) => !pendingDeletes.has(pkValue))
      .map(({ row, pkValue }) => ({
        rowKey: pkValue,
        inserted: false,
        deleted: false,
        cells: columns.map((c, i) => cellValue(pkValue, i, row[i])),
      }));
    const inserted = pendingInserts.map((ins) => ({
      rowKey: `ins:${ins.id}`,
      inserted: true,
      deleted: false,
      cells: columns.map((c) => ({ value: ins.values[c.name], edited: ins.values[c.name] != null })),
    }));
    return [...server, ...inserted];
  }, [rows, columns, pkColumn, pendingUpdates, pendingDeletes, pendingInserts]);

  // Cell/row selection copy: resolve raw values from the derived view so the
  // clipboard matches what is displayed (including staged edits). Esc clears
  // the selection; Cmd/Ctrl+C copies the cell (or the whole row, tab-joined,
  // when the row number was clicked).
  useEffect(() => {
    if (!selected) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.key === 'Escape') { setSelected(null); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
        const row = displayRows.find((r) => r.rowKey === selected.rowKey);
        if (!row) return;
        let text: string | null = null;
        if (selected.column == null) {
          text = row.cells.map((c) => (c.value == null ? '' : String(c.value))).join('\t');
        } else {
          const idx = columns.findIndex((c) => c.name === selected.column);
          if (idx >= 0) {
            const value = row.cells[idx]?.value;
            text = value == null ? '' : String(value);
          }
        }
        if (text != null) void navigator.clipboard.writeText(text);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selected, displayRows, columns]);

  if (!table) {
    return <div className="p-4 text-sm text-muted-foreground">{t('db.workbench.noSelection')}</div>;
  }

  const editable = Boolean(pkColumn);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-1.5 border-b border-border/60 flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
        <span className="font-medium text-foreground">{schema ? `${schema}.${table}` : table}</span>
        {estimate != null && <span>{t('db.workbench.estimateRows', { count: estimate })}</span>}
        {!editable && <span className="text-amber-500">{t('db.grid.noPk')}</span>}
        <div className="ml-auto flex items-center gap-1 flex-wrap">
          {pendingCount > 0 && (
            <>
              <span className="text-amber-500">{t('db.grid.pending', { count: pendingCount })}</span>
              <Button variant="ghost" size="sm" className="h-7" disabled={applying} onClick={revertAll}>
                <RotateCcw size={12} className="mr-1" />{t('db.grid.revert')}
              </Button>
              <Button variant="default" size="sm" className="h-7 font-medium" disabled={applying} onClick={() => void applyChanges()}>
                <Check size={12} className="mr-1" />{t('db.grid.apply')}
              </Button>
            </>
          )}
          {editable && (
            <Button variant="outline" size="sm" className="h-7" onClick={addRow}>
              <Plus size={12} className="mr-1" />{t('db.grid.addRow')}
            </Button>
          )}
          {editable && (
            <Button variant="outline" size="sm" className="h-7" onClick={() => setImportOpen(true)}>
              <Upload size={12} className="mr-1" />{t('db.grid.importCsv')}
            </Button>
          )}
          <select aria-label={t('db.grid.filter.column')}
            className="h-7 max-w-[130px] rounded border border-border bg-background px-1 text-xs"
            value={filterColumn}
            onChange={(e) => setFilterColumn(e.target.value)}>
            <option value="">{t('db.grid.filter.column')}</option>
            {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
          <select aria-label={t('db.grid.filter.op')}
            className="h-7 rounded border border-border bg-background px-1 text-xs"
            value={filterOp}
            onChange={(e) => setFilterOp(e.target.value as DbGridFilter['op'])}>
            {FILTER_OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {filterOp !== 'nul' && filterOp !== 'nnul' && (
            <input aria-label={t('db.grid.filter.value')} placeholder={t('db.grid.filter.value')}
              className="h-7 w-28 rounded border border-border bg-background px-1 text-xs"
              value={filterValue}
              onChange={(e) => setFilterValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applyFilter(); }} />
          )}
          <Button variant="outline" size="sm" className="h-7" disabled={!filterColumn || filters.length >= MAX_FILTERS} onClick={applyFilter}>
            {t('db.grid.filter.apply')}
          </Button>
          <Button variant="ghost" size="sm" className="h-7" disabled={filters.length === 0} onClick={clearFilters}>
            {t('db.grid.filter.clear')}
          </Button>
          {filters.map((f, i) => (
            <span key={`${f.column}:${f.op}:${i}`}
              className="inline-flex items-center gap-1 rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-600 dark:text-sky-400">
              {f.column} {filterOpLabel(f.op)}{f.op !== 'nul' && f.op !== 'nnul' ? ` ${f.value ?? ''}` : ''}
              <button type="button" aria-label={t('db.grid.filter.remove')} className="rounded hover:bg-foreground/10" onClick={() => removeFilter(i)}>
                <X size={10} />
              </button>
            </span>
          ))}
          <select aria-label={t('db.grid.exportCsv')}
            className="h-7 rounded border border-border bg-background px-1 text-xs"
            value={exportFormat}
            onChange={(e) => setExportFormat(e.target.value as ExportFormat)}>
            <option value="csv">{t('db.grid.exportCsv')}</option>
            <option value="json">{t('db.export.json')}</option>
            <option value="inserts">{t('db.export.inserts')}</option>
          </select>
          <Button variant="outline" size="sm" className="h-7" onClick={exportData}>
            <Download size={12} className="mr-1" />{exportFormat === 'csv' ? t('db.grid.exportCsv') : exportFormat === 'json' ? t('db.export.json') : t('db.export.inserts')}
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" disabled={offset === 0 || loading} aria-label={t('db.workbench.page.prev')} onClick={() => void fetchPage(offset - PAGE_SIZE, orderBy, orderDir, filters)}>
            <ChevronLeft size={13} />
          </Button>
          <span>{offset + 1}–{offset + rows.length}</span>
          <Button variant="ghost" size="icon" className="h-7 w-7" disabled={rows.length < PAGE_SIZE || loading} aria-label={t('db.workbench.page.next')} onClick={() => void fetchPage(offset + PAGE_SIZE, orderBy, orderDir, filters)}>
            <ChevronRight size={13} />
          </Button>
        </div>
      </div>
      {error && <p className="text-destructive text-xs px-3 py-2">{error}</p>}
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b border-border/60">
              <th className="px-2 py-1 text-left font-medium text-muted-foreground">#</th>
              {editable && <th className="px-2 py-1 w-8" />}
              {columns.map((c) => {
                const isSorted = orderBy === c.name && orderDir != null;
                return (
                  <th key={c.name}
                    className="px-2 py-1 text-left font-medium"
                    aria-sort={isSorted ? (orderDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button type="button"
                      className="inline-flex items-center gap-0.5 hover:text-foreground"
                      onClick={() => toggleSort(c.name)}>
                      {c.name}
                      {c.name === pkColumn && <span className="ml-1 text-[9px] text-amber-500">PK</span>}
                      {isSorted && (orderDir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {displayRows.map(({ rowKey, inserted, cells }) => {
              const isDeleted = pendingDeletes.has(rowKey);
              return (
                <tr key={rowKey} className={`group border-b border-border/30 hover:bg-foreground/5 ${inserted ? 'bg-emerald-500/5' : ''}`}>
                  <td aria-label="Select row"
                    className={`px-2 py-1 text-muted-foreground align-top ${selected?.rowKey === rowKey && selected.column == null ? 'ring-1 ring-inset ring-sky-500' : ''}`}
                    onClick={() => setSelected({ rowKey, column: null })}>
                    {inserted ? <span className="text-emerald-600 dark:text-emerald-400">+</span> : ''}
                  </td>
                  {editable && (
                    <td className="px-1 py-1 align-top">
                      <button type="button" aria-label={t('db.grid.deleteRow')}
                        className={`p-0.5 rounded hover:bg-foreground/10 ${isDeleted ? 'text-destructive' : 'text-muted-foreground'}`}
                        onClick={() => markDeleteRow(rowKey)}>
                        {isDeleted ? <RotateCcw size={12} /> : <Trash2 size={12} />}
                      </button>
                    </td>
                  )}
                  {cells.map((cell, j) => {
                    const colName = columns[j]?.name ?? '';
                    const fk = colName ? fkByColumn.get(colName) : undefined;
                    const isEditing = editing && editing.rowKey === rowKey && editing.column === colName;
                    const isSelected = selected?.rowKey === rowKey && selected.column === colName;
                    return (
                      <td key={colName}
                        className={`px-2 py-1 font-mono truncate max-w-[320px] align-top ${cell.edited ? 'bg-sky-500/10' : ''} ${isDeleted ? 'line-through opacity-50' : ''} ${inserted ? '' : editable ? 'cursor-cell' : ''} ${isSelected ? 'ring-1 ring-inset ring-sky-500' : ''}`}
                        title={isEditing || cell.value == null ? undefined : String(cell.value)}
                        onClick={isEditing ? undefined : () => setSelected({ rowKey, column: colName })}
                        onDoubleClick={editable && !isEditing ? () => startEdit(rowKey, colName, cell.value) : undefined}>
                        {isEditing ? (
                          <span className="flex items-center gap-1">
                            <input autoFocus
                              className="w-full min-w-[80px] h-5 px-1 bg-background border border-border rounded text-xs font-mono"
                              value={editing.isNull ? '' : editing.value}
                              placeholder="NULL"
                              disabled={editing.isNull}
                              onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitEdit();
                                else if (e.key === 'Escape') setEditing(null);
                              }}
                            />
                            <label className="text-[9px] text-muted-foreground whitespace-nowrap flex items-center gap-0.5">
                              <input type="checkbox" checked={editing.isNull} onChange={(e) => setEditing({ ...editing, isNull: e.target.checked })} />NULL
                            </label>
                            <button type="button" aria-label="confirm" className="p-0.5 rounded hover:bg-foreground/10 text-emerald-600" onClick={commitEdit}>
                              <Check size={12} />
                            </button>
                            <button type="button" aria-label="cancel" className="p-0.5 rounded hover:bg-foreground/10 text-muted-foreground" onClick={() => setEditing(null)}>
                              <X size={12} />
                            </button>
                          </span>
                        ) : (
                          <>
                            {cell.edited && <span className="inline-block mr-1 align-middle w-1.5 h-1.5 rounded-full bg-sky-500" />}
                            {cell.value == null
                              ? <span className="text-muted-foreground italic">NULL</span>
                              : String(cell.value)}
                            {fk && cell.value != null && onNavigateForeignKey && (
                              <button type="button"
                                className="ml-1 inline-flex align-middle rounded text-muted-foreground opacity-0 focus:opacity-100 group-hover:opacity-100 hover:text-sky-500"
                                aria-label={t('db.fk.jump')}
                                title={`${fk.refSchema ? `${fk.refSchema}.` : ''}${fk.refTable}.${fk.refColumn} = ${String(cell.value)}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onNavigateForeignKey({ table: fk.refTable, schema: fk.refSchema, column: fk.refColumn, value: String(cell.value) });
                                }}>
                                <ArrowUpRight size={11} />
                              </button>
                            )}
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        {truncated && <p className="text-amber-500 text-xs px-3 py-2">{t('db.workbench.truncated')}</p>}
      </div>
      {importOpen && (
        <SqlImportWizard
          connectionId={connectionId}
          dialect={dialect}
          table={table}
          schema={schema}
          columns={columns.map((c) => c.name)}
          onClose={() => setImportOpen(false)}
          onImported={() => { setImportOpen(false); void fetchPage(0, orderBy, orderDir, filters); }}
        />
      )}
    </div>
  );
};

export default SqlTableData;
