import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  BOX_HEIGHT_BASE, BOX_WIDTH, DRAG_CLICK_SLOP_PX, ROW_HEIGHT, calculateBoxHeights, computeFkAnchors,
  erdCommentText, erdTitleText, layoutBoxes, movedBeyondSlop,
  type ErdBox, type ErdFkEdge,
} from './erdLayout';

const box = (id: string, columnCount: number): ErdBox => ({ id, title: id, columns: [], columnCount, x: 0, y: 0 });

test('boxes flow left-to-right then wrap to a new band (no overlap)', () => {
  const boxes = layoutBoxes(
    ['a', 'b', 'c', 'd'].map(box),
    { boxWidth: BOX_WIDTH, gapX: 40, bandGapY: 60, maxPerBand: 3 },
  );
  const positions = boxes.map((b) => ({ id: b.id, x: b.x, y: b.y }));
  // Band 0: a, b, c. Band 1: d — one bandGapY below the band's tallest box
  // (2 columns → BOX_HEIGHT_BASE + 2*ROW_HEIGHT).
  const band0Height = BOX_HEIGHT_BASE + 2 * ROW_HEIGHT;
  assert.deepEqual(positions, [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: BOX_WIDTH + 40, y: 0 },
    { id: 'c', x: (BOX_WIDTH + 40) * 2, y: 0 },
    { id: 'd', x: 0, y: band0Height + 60 },
  ]);
});

test('box heights scale with column count and band y stacks tallest in the band', () => {
  const boxes = ['small', 'tall'].map((id) => (id === 'tall' ? { ...box(id, 12), } : box(id, 2)));
  const laid = layoutBoxes(boxes, { boxWidth: BOX_WIDTH, gapX: 40, bandGapY: 60, maxPerBand: 4 });
  const heights = calculateBoxHeights(boxes);
  assert.equal(heights.get('tall'), BOX_HEIGHT_BASE + 12 * ROW_HEIGHT);
  // Both boxes share band 0 whose height is driven by the tallest one.
  assert.equal(laid[1].y, laid[0].y);
  assert.equal(laid[1].id, 'tall');
});

test('FK anchors point from the source column row to the target column row', () => {
  const boxes: ErdBox[] = [
    { id: 'child', title: 'child', columns: [{ name: 'id' }, { name: 'parent_id' }], columnCount: 2, x: 0, y: 0 },
    { id: 'parent', title: 'parent', columns: [{ name: 'id' }, { name: 'name' }], columnCount: 2, x: 300, y: 200 },
  ];
  const edges: ErdFkEdge[] = [
    { source: 'child', target: 'parent', sourceColumns: ['parent_id'], targetColumns: ['id'] },
  ];
  const anchors = computeFkAnchors(boxes, edges);
  assert.equal(anchors.length, 1);
  const a = anchors[0];
  // Source anchor sits on the child's right edge at the parent_id row center;
  // target anchor on the parent's left edge at the id row center.
  assert.equal(a.fromX, BOX_WIDTH);
  assert.equal(a.fromY, 0 + 24 + 1 * ROW_HEIGHT + ROW_HEIGHT / 2);
  assert.equal(a.toX, 300);
  assert.equal(a.toY, 200 + 24 + 0 * ROW_HEIGHT + ROW_HEIGHT / 2);
});

test('edges referencing unknown tables or columns fall back to box centers', () => {
  const boxes: ErdBox[] = [{ id: 'solo', title: 'solo', columns: [{ name: 'id' }], columnCount: 1, x: 10, y: 20 }];
  const anchors = computeFkAnchors(boxes, [
    { source: 'solo', target: 'ghost', sourceColumns: ['nope'], targetColumns: ['x'] },
  ]);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].fromY, 20 + 24 + ROW_HEIGHT / 2); // 'id' column not found either → first row
  assert.ok(Number.isFinite(anchors[0].toX) && Number.isFinite(anchors[0].toY));
});

test('the ER panel keeps exactly one entry: the top tab (toolbar duplicates removed)', () => {
  const panel = readFileSync(new URL('./SqlErdPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /computeFkAnchors/);
  assert.match(panel, /db\.erd\.title/);
  // The schema-tree toolbar ER button duplicated the top tab (and briefly
  // referenced the dead setSqlErdOpen) — the prop and button are gone.
  const tree = readFileSync(new URL('./SqlSchemaTree.tsx', import.meta.url), 'utf8');
  assert.ok(!tree.includes('onOpenErd'), 'the tree toolbar ER entry must stay removed');
  const workbench = readFileSync(new URL('./DatabaseWorkbench.tsx', import.meta.url), 'utf8');
  assert.match(workbench, /SqlErdPanel/);
  assert.ok(!workbench.includes('onOpenErd'), 'no tree toolbar entry may come back');
  assert.ok(!workbench.includes('setSqlErdOpen'), 'the removed sqlErdOpen state must not be referenced');
  // The top-tab switcher keeps sessions/erd reachable.
  assert.match(workbench, /'workbench', 'backup', 'sessions', 'erd'/);
});

// ——— inline column comments (描述) ————————————————————————————————————————

test('erdCommentText returns null without a comment or when the name leaves no room', () => {
  assert.equal(erdCommentText('id', null), null);
  assert.equal(erdCommentText('id', undefined), null);
  assert.equal(erdCommentText('id', ''), null);
  // A 30-char name consumes most of the 210px box — nothing readable fits.
  assert.equal(erdCommentText('very_long_column_identifier_name_x', '备注'), null);
});

test('erdCommentText keeps a short comment verbatim (latin and CJK)', () => {
  assert.equal(erdCommentText('id', '主键ID'), '主键ID');
  assert.equal(erdCommentText('id', 'Primary key'), 'Primary key');
});

test('erdCommentText truncates long latin comments with an ellipsis', () => {
  const long = 'external description that goes on and on and on';
  const out = erdCommentText('id', long);
  assert.ok(out && out.endsWith('…'), 'must truncate with …');
  assert.ok(out.length < long.length);
  // Truncation budget: BOX_WIDTH 210 − 16 padding − 2*6 name − 6 gap → 32 units.
  assert.equal(out, long.slice(0, 31) + '…');
});

test('erdCommentText counts CJK characters double when truncating', () => {
  const cjk = '这是一段非常长的中文列描述信息需要被截断处理掉';
  const out = erdCommentText('id', cjk);
  assert.ok(out && out.endsWith('…'));
  // 32-unit budget → 15 CJK chars (30 units) fit before the ellipsis.
  assert.equal(out, cjk.slice(0, 15) + '…');
});

test('the ER panel maps tableMeta comments through and renders them inline', () => {
  const panel = readFileSync(new URL('./SqlErdPanel.tsx', import.meta.url), 'utf8');
  // comment flows from tableMeta into the box columns…
  assert.match(panel, /comment: c\.comment \?\? null/);
  // …the truncated fragment renders as a styled tspan after the name…
  assert.match(panel, /erdCommentText\(col\.name, col\.comment\)/);
  assert.match(panel, /<tspan className="fill-muted-foreground\/60 font-sans italic"/);
  // …and the raw text stays reachable as a hover title.
  assert.match(panel, /<title>\{`\$\{col\.name\}: \$\{col\.comment\}`\}<\/title>/);
});

// ——— pan-vs-click: a drag release must not open the table ——————————————————

test('movedBeyondSlop separates a pan gesture from a click', () => {
  // Sub-slop jitters stay clicks; real drags flip past the threshold.
  assert.equal(DRAG_CLICK_SLOP_PX > 0, true);
  assert.equal(movedBeyondSlop(100, 100, 101, 102), false, '2px manhattan → still a click');
  assert.equal(movedBeyondSlop(100, 100, 100, 100 + DRAG_CLICK_SLOP_PX), false, 'exactly at slop → click');
  assert.equal(movedBeyondSlop(100, 100, 100 + DRAG_CLICK_SLOP_PX + 1, 100), true);
  assert.equal(movedBeyondSlop(100, 100, 94, 100), true, 'leftward drags count too');
});

test('the ER panel suppresses the box click after a real drag', () => {
  const panel = readFileSync(new URL('./SqlErdPanel.tsx', import.meta.url), 'utf8');
  // The drag gesture is tracked and checked before opening the table…
  assert.match(panel, /didDragRef/);
  assert.match(panel, /movedBeyondSlop\(drag\.startX, drag\.startY, e\.clientX, e\.clientY\)/);
  // …the pending flag resets on both gesture start and after a suppressed click…
  assert.match(panel, /didDragRef\.current = false/);
  // …and the box onClick bails out before onOpenData while the flag is set.
  assert.match(panel, /if \(didDragRef\.current\) \{\s*didDragRef\.current = false;\s*return;\s*\}/);
});

// ——— box titles: schema.table must never overflow the box ——————————————————

test('erdTitleText keeps short ids verbatim', () => {
  assert.equal(erdTitleText('users'), 'users');
  assert.equal(erdTitleText('public.users'), 'public.users');
});

test('erdTitleText drops the schema prefix when schema.table overflows', () => {
  // The user-reported overflow: 36 chars ≈ 238px against a 194px budget.
  const id = 'satms_common.t_common_bootstrap_file';
  assert.ok(id.length > 29, 'precondition: the id exceeds the ~29-char budget');
  assert.equal(erdTitleText(id), 't_common_bootstrap_file');
});

test('erdTitleText end-truncates an over-long bare table name', () => {
  const bare = 't_common_bootstrap_file_with_a_very_long_name';
  const out = erdTitleText(bare);
  assert.ok(out.endsWith('…'), 'must truncate with …');
  assert.equal(out, bare.slice(0, 28) + '…', '29-char budget: 28 chars + ellipsis');
});

test('the ER panel renders the fitted title with the full id as hover title', () => {
  const panel = readFileSync(new URL('./SqlErdPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /erdTitleText\(b\.title\)/);
  assert.match(panel, /<title>\{b\.title\}<\/title>/);
});
