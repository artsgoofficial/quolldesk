/**
 * ER diagram layout math (pure): box grid flow, per-box heights driven by the
 * column count, and FK edge anchor points at column-row centers. The panel
 * renders these as SVG; zoom/pan only transform the viewport, never this data.
 */

/** Fixed box geometry (px in diagram space). */
export const BOX_WIDTH = 210;
export const BOX_HEADER_HEIGHT = 24;
export const ROW_HEIGHT = 18;
export const BOX_HEIGHT_BASE = BOX_HEADER_HEIGHT + 6;

export interface ErdColumn {
  name: string;
  /** Column description (db comment) rendered inline after the name. */
  comment?: string | null;
}

export interface ErdBox {
  id: string;
  title: string;
  columns: ErdColumn[];
  /** Real column count (the rendered list may be capped). */
  columnCount: number;
  x: number;
  y: number;
}

export interface ErdFkEdge {
  source: string;
  target: string;
  sourceColumns: string[];
  targetColumns: string[];
}

export interface ErdFkAnchor {
  edgeIndex: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

// Inline comment geometry: the name renders in 10px mono (~6px/char) and the
// comment in 9px sans (~5.5px per latin unit); CJK ideographs count double.
const COMMENT_UNIT_PX = 5.5;
const NAME_CHAR_PX = 6;
const COMMENT_GAP_PX = 6;
/** Below this the fragment reads as noise — hide it instead. */
const MIN_COMMENT_UNITS = 4;

const isWideChar = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xffef) ||
  (cp >= 0x20000 && cp <= 0x3fffd);

/**
 * The comment fragment shown inline after a column name: the full text that
 * fits between the name and the box's right padding, ellipsized when it does
 * not (the panel adds a hover title with the raw text). Returns null when
 * there is no comment or no meaningful room left.
 */
export const erdCommentText = (
  name: string,
  comment: string | null | undefined,
  boxWidth: number = BOX_WIDTH,
): string | null => {
  if (!comment) return null;
  const budgetUnits = Math.floor((boxWidth - 16 - name.length * NAME_CHAR_PX - COMMENT_GAP_PX) / COMMENT_UNIT_PX);
  if (budgetUnits < MIN_COMMENT_UNITS) return null;
  let units = 0;
  let out = '';
  for (const ch of comment) {
    const w = isWideChar(ch.codePointAt(0) ?? 0) ? 2 : 1;
    if (units + w > budgetUnits - 1) return `${out}…`;
    units += w;
    out += ch;
  }
  return out;
};

/**
 * Pan-vs-click discrimination: the browser still fires a native click when a
 * drag starts and ends over the same element, which would open the table the
 * user merely dragged past. Movement over this many px (manhattan) counts as
 * a pan gesture; anything smaller is hand jitter on a real click.
 */
export const DRAG_CLICK_SLOP_PX = 3;

export const movedBeyondSlop = (startX: number, startY: number, endX: number, endY: number): boolean =>
  Math.abs(endX - startX) + Math.abs(endY - startY) > DRAG_CLICK_SLOP_PX;

// Box title: 11px mono (~6.6px/char) with 8px padding each side. A qualified
// `schema.table` id overflows quickly (satms_common.t_common_bootstrap_file is
// ~238px against a 194px budget), so the display drops the schema prefix —
// the table name is what FK lines and navigation care about — and end-truncates
// when even the bare name is too wide. The full id stays on the hover title.
const TITLE_CHAR_PX = 6.6;

export const erdTitleText = (id: string, boxWidth: number = BOX_WIDTH): string => {
  const maxChars = Math.floor((boxWidth - 16) / TITLE_CHAR_PX);
  if (id.length <= maxChars) return id;
  const table = id.slice(id.lastIndexOf('.') + 1);
  if (table.length <= maxChars) return table;
  return `${table.slice(0, Math.max(1, maxChars - 1))}…`;
};

export interface LayoutOptions {
  boxWidth: number;
  gapX: number;
  bandGapY: number;
  /** Max boxes per horizontal band. */
  maxPerBand: number;
}

const boxHeight = (columnCount: number): number =>
  BOX_HEIGHT_BASE + Math.max(1, columnCount) * ROW_HEIGHT;

/** Per-box heights keyed by box id. */
export const calculateBoxHeights = (boxes: ErdBox[]): Map<string, number> => {
  const map = new Map<string, number>();
  for (const b of boxes) map.set(b.id, boxHeight(b.columnCount));
  return map;
};

/**
 * Grid-flow layout: boxes fill a band left-to-right; when the band is full the
 * next band starts one bandGapY below the tallest box of the previous band.
 * Deterministic, dependency-free, and stable across data reloads (input order).
 */
export const layoutBoxes = (boxes: ErdBox[], opts: LayoutOptions): ErdBox[] => {
  const heights = calculateBoxHeights(boxes);
  const out: ErdBox[] = [];
  let index = 0;
  let bandY = 0;
  while (index < boxes.length) {
    const band = boxes.slice(index, index + opts.maxPerBand);
    let x = 0;
    let tallest = 0;
    for (const b of band) {
      const h = heights.get(b.id) ?? BOX_HEIGHT_BASE;
      out.push({ ...b, x, y: bandY });
      x += opts.boxWidth + opts.gapX;
      if (h > tallest) tallest = h;
    }
    bandY += tallest + opts.bandGapY;
    index += band.length;
  }
  return out;
};

const columnCenterY = (b: ErdBox, columnName: string): number => {
  const idx = b.columns.findIndex((c) => c.name === columnName);
  const row = idx === -1 ? 0 : idx;
  return b.y + BOX_HEADER_HEIGHT + row * ROW_HEIGHT + ROW_HEIGHT / 2;
};

/**
 * Anchor each FK edge at the source box's right edge and the target box's
 * left edge, vertically at the paired column-row centers. Edges referencing
 * unknown boxes/cols degrade to box centers (first column row) — the line
 * still renders, it is just less precise.
 */
export const computeFkAnchors = (boxes: ErdBox[], edges: ErdFkEdge[]): ErdFkAnchor[] => {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const anchors: ErdFkAnchor[] = [];
  edges.forEach((edge, edgeIndex) => {
    const source = byId.get(edge.source);
    if (!source) return; // no source box → the line has no origin at all
    const target = byId.get(edge.target);
    const sourceCol = edge.sourceColumns[0] ?? '';
    const targetCol = edge.targetColumns[0] ?? '';
    anchors.push({
      edgeIndex,
      fromX: source.x + BOX_WIDTH,
      fromY: columnCenterY(source, sourceCol),
      // Unknown target box: draw a short dangling stub to its right so the
      // broken reference stays visible instead of silently disappearing.
      toX: target ? target.x : source.x + BOX_WIDTH + 80,
      toY: target ? columnCenterY(target, targetCol) : columnCenterY(source, sourceCol),
    });
  });
  return anchors;
};
