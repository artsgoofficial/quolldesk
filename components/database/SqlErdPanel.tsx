/**
 * ER diagram panel (DBeaver-style, read-only v1): every table as a box with
 * its column list, FK references drawn as bezier edges anchored at column
 * rows. Data: schemaTree + per-table tableMeta (canonical FK shape). Wheel
 * zooms, empty-space drag pans — both only transform the viewport.
 */
import { ArrowLeft, Loader2, RefreshCw } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { SQL_ENGINE_BY_ID, type SqlEngineId } from '../../domain/models/dbEngines';
import { databaseClient, dbErrorMessage } from '@/infrastructure/services/databaseClient';
import { fetchSqlSchemaTree } from '@/infrastructure/services/sqlSchemaTreeCache';
import { Button } from '../ui/button';
import {
  BOX_WIDTH, BOX_HEADER_HEIGHT, ROW_HEIGHT,
  computeFkAnchors, erdCommentText, erdTitleText, layoutBoxes, movedBeyondSlop, type ErdBox, type ErdFkEdge,
} from './erdLayout';

const MAX_TABLES = 50;
const MAX_COLUMNS_SHOWN = 14;

interface SqlErdPanelProps {
  connectionId: string;
  dialect: SqlEngineId;
  /** Active schema for schemaQualified engines; empty = first schema found. */
  selectedSchema?: string;
  onOpenData: (table: string, schema?: string) => void;
  onClose: () => void;
}

interface ErdModel {
  boxes: ErdBox[];
  edges: ErdFkEdge[];
  totalTables: number;
}

export const SqlErdPanel: React.FC<SqlErdPanelProps> = ({ connectionId, dialect, selectedSchema, onOpenData, onClose }) => {
  const { t } = useI18n();
  const client = databaseClient[dialect];
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<ErdModel | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setModel(null);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    try {
      const tree = await fetchSqlSchemaTree(dialect, connectionId);
      const schemaQualified = SQL_ENGINE_BY_ID[dialect].schemaQualified;
      const jobs: { schema: string | null; table: string }[] = [];
      for (const db of tree.databases) {
        if (schemaQualified && selectedSchema && db.name !== selectedSchema) continue;
        for (const table of db.tables) jobs.push({ schema: schemaQualified ? db.name : null, table });
      }
      const capped = jobs.slice(0, MAX_TABLES);
      const boxes: ErdBox[] = [];
      const edges: ErdFkEdge[] = [];
      for (const job of capped) {
        const meta = await client.tableMeta({ connectionId, table: job.table, schema: job.schema ?? undefined });
        const id = job.schema ? `${job.schema}.${job.table}` : job.table;
        boxes.push({
          id, title: id,
          columns: meta.columns.slice(0, MAX_COLUMNS_SHOWN).map((c) => ({ name: c.name, comment: c.comment ?? null })),
          columnCount: meta.columns.length,
          x: 0, y: 0,
        });
        for (const fk of meta.foreignKeys) {
          const refId = fk.refSchema ? `${fk.refSchema}.${fk.refTable}` : fk.refTable;
          edges.push({ source: id, target: refId, sourceColumns: fk.columns, targetColumns: fk.refColumns });
        }
      }
      setModel({ boxes: layoutBoxes(boxes, { boxWidth: BOX_WIDTH, gapX: 60, bandGapY: 80, maxPerBand: 5 }), edges, totalTables: jobs.length });
    } catch (err) {
      setError(dbErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [connectionId, dialect, selectedSchema, client]);

  useEffect(() => { void load(); }, [load]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((prev) => Math.min(2.5, Math.max(0.25, prev * (e.deltaY > 0 ? 0.9 : 1.1))));
  }, []);

  // The release after a pan still fires a native click on the box under the
  // cursor — without this flag that click would open the table's data view
  // right as the user finishes dragging.
  const didDragRef = useRef(false);
  const onDragStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    didDragRef.current = false;
    dragRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
  }, [pan]);
  const onDragMove = useCallback((e: React.MouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (movedBeyondSlop(drag.startX, drag.startY, e.clientX, e.clientY)) didDragRef.current = true;
    setPan({ x: drag.panX + (e.clientX - drag.startX), y: drag.panY + (e.clientY - drag.startY) });
  }, []);
  const onDragEnd = useCallback(() => { dragRef.current = null; }, []);

  const anchors = model ? computeFkAnchors(model.boxes, model.edges) : [];

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-2 py-1.5 border-b border-border/60 flex items-center gap-1.5 shrink-0 app-no-drag">
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onClose} title={t('db.search.back')}>
          <ArrowLeft size={13} />
        </Button>
        <span className="text-xs font-medium">{t('db.erd.title')}</span>
        {model && model.totalTables > model.boxes.length && (
          <span className="text-[11px] text-amber-500">{t('db.erd.capped', { shown: model.boxes.length, total: model.totalTables })}</span>
        )}
        <Button variant="ghost" size="sm" className="h-7 px-2 ml-auto" onClick={() => void load()} disabled={loading} title={t('common.refresh')}>
          <RefreshCw size={12} />
        </Button>
      </div>
      <div className="px-2 pb-1 text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap shrink-0">
        <span>{t('db.erd.legend')}</span>
        {model && model.edges.length === 0 && model.boxes.length > 0 && (
          <span className="text-amber-500">{t('db.erd.noFk')}</span>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden relative bg-foreground/[0.02]"
        onWheel={onWheel}
        onMouseDown={onDragStart}
        onMouseMove={onDragMove}
        onMouseUp={onDragEnd}
        onMouseLeave={onDragEnd}
        style={{ cursor: dragRef.current ? 'grabbing' : 'grab' }}>
        {loading && (
          <p className="absolute inset-0 flex items-center justify-center gap-1.5 text-muted-foreground text-xs">
            <Loader2 size={14} className="animate-spin" />
            {t('db.erd.loading')}
          </p>
        )}
        {error && <p className="absolute inset-0 flex items-center justify-center text-destructive text-xs">{error}</p>}
        {!loading && !error && model && (
          <svg
            width="100%"
            height="100%"
            role="img"
            aria-label={t('db.erd.title')}
            data-testid="erd-svg"
          >
            <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
              {/* FK edges under the boxes */}
              {anchors.map((a, i) => (
                <path
                  key={`edge-${i}`}
                  d={`M ${a.fromX} ${a.fromY} C ${a.fromX + 60} ${a.fromY}, ${a.toX - 60} ${a.toY}, ${a.toX} ${a.toY}`}
                  fill="none"
                  stroke="currentColor"
                  className="text-muted-foreground/60"
                  strokeWidth={1.2}
                />
              ))}
              {model.boxes.map((b) => {
                const h = BOX_HEADER_HEIGHT + b.columnCount * ROW_HEIGHT + 4;
                return (
                  <g key={b.id} className="cursor-pointer" onClick={() => {
                    // A pan release lands here as a native click — swallow it.
                    if (didDragRef.current) { didDragRef.current = false; return; }
                    const [schema, table] = b.id.includes('.') ? b.id.split('.') : [undefined, b.id];
                    onOpenData(table, schema);
                  }}>
                    <rect x={b.x} y={b.y} width={BOX_WIDTH} height={h} rx={6}
                      className="fill-background stroke-border" strokeWidth={1} />
                    <rect x={b.x} y={b.y} width={BOX_WIDTH} height={BOX_HEADER_HEIGHT} rx={6}
                      className="fill-foreground/10" />
                    <text x={b.x + 8} y={b.y + 16} className="text-[11px] font-mono fill-foreground">
                      {/* fitted display text; the full schema.table stays on hover */}
                      <title>{b.title}</title>
                      {erdTitleText(b.title)}
                    </text>
                    {b.columns.map((col, i) => {
                      // Description inline after the name (truncated to the box
                      // width); the raw text stays available as the hover title.
                      const comment = erdCommentText(col.name, col.comment);
                      return (
                        <text key={col.name} x={b.x + 8} y={b.y + BOX_HEADER_HEIGHT + (i + 1) * ROW_HEIGHT - 5}
                          className="text-[10px] font-mono fill-muted-foreground">
                          {col.comment && <title>{`${col.name}: ${col.comment}`}</title>}
                          {col.name}
                          {comment && (
                            <tspan className="fill-muted-foreground/60 font-sans italic" dx="6">{comment}</tspan>
                          )}
                        </text>
                      );
                    })}
                    {b.columnCount > MAX_COLUMNS_SHOWN + 0 && (
                      <text x={b.x + 8} y={b.y + h - 4} className="text-[10px] fill-muted-foreground">
                        …
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        )}
        {!loading && !error && model && model.boxes.length === 0 && (
          <p className="absolute inset-0 flex items-center justify-center text-muted-foreground text-xs">
            {t('db.erd.empty')}
          </p>
        )}
        <span className="absolute bottom-2 right-3 text-[10px] text-muted-foreground select-none">
          {Math.round(zoom * 100)}%
        </span>
      </div>
    </div>
  );
};

export default SqlErdPanel;
