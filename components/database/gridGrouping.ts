/**
 * Grid GROUP BY panel math (pure): group the loaded view's rows by one
 * column and aggregate count + numeric sum per group. Renderer-only — no
 * server round trip; large groups are capped at the panel level.
 */

export interface GroupedRow {
  value: string;
  count: number;
  /** Groups with zero numeric members report null sum. */
  sum: number | null;
}

export interface GroupEntry {
  key: unknown;
  num: unknown;
}

/** Group entries by `key`, counting rows and summing finite numeric `num`s. */
export const groupStats = (entries: GroupEntry[]): GroupedRow[] => {
  const map = new Map<string, { count: number; numericCount: number; sum: number }>();
  for (const e of entries) {
    const key = e.key == null || String(e.key) === '' ? 'NULL' : String(e.key);
    const cur = map.get(key) ?? { count: 0, numericCount: 0, sum: 0 };
    cur.count += 1;
    const n = typeof e.num === 'number' ? e.num : Number(e.num);
    if (e.num != null && e.num !== '' && Number.isFinite(n)) {
      cur.numericCount += 1;
      cur.sum += n;
    }
    map.set(key, cur);
  }
  // Busiest groups first — the panel caps the rendered list anyway.
  return [...map.entries()]
    .map(([value, s]) => ({ value, count: s.count, sum: s.numericCount > 0 ? s.sum : null }))
    .sort((a, b) => b.count - a.count);
};
