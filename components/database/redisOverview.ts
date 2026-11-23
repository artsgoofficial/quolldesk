/**
 * Pure helpers behind the Redis overview panel (keys-view empty state).
 * All inputs come from the flattened INFO summary the workbench already
 * fetches via serverInfo — no bridge calls of their own.
 */

export interface RedisKeyspace {
  keys: number;
  expires: number;
  avgTtlMs: number | null;
}

/**
 * Parse the dbN INFO keyspace entry ("db0:keys=5,expires=2,avg_ttl=123" is
 * flattened by the bridge to summary.db0). Returns null when the db has no
 * entry (empty/absent) or the counts are malformed; a missing avg_ttl still
 * yields the counts.
 */
export const parseKeyspace = (summary: Record<string, string>, db: number): RedisKeyspace | null => {
  const raw = summary[`db${db}`];
  if (!raw) return null;
  let keys: number | null = null;
  let expires: number | null = null;
  let avgTtlMs: number | null = null;
  for (const part of raw.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = Number(part.slice(eq + 1).trim());
    if (!Number.isFinite(value)) continue;
    if (name === 'keys') keys = value;
    else if (name === 'expires') expires = value;
    else if (name === 'avg_ttl') avgTtlMs = value;
  }
  if (keys == null || expires == null) return null;
  return { keys, expires, avgTtlMs };
};

/** Cache hit rate as a fraction (0..1); null when there is no traffic. */
export const redisHitRate = (summary: Record<string, string>): number | null => {
  const hits = Number(summary.keyspace_hits);
  const misses = Number(summary.keyspace_misses);
  if (!Number.isFinite(hits) || !Number.isFinite(misses)) return null;
  const total = hits + misses;
  return total > 0 ? hits / total : null;
};

/**
 * Humanize milliseconds the way the overview shows avg TTL: pick the largest
 * unit that fits and keep one smaller unit. Null for absent/zero values.
 */
export const formatDurationMs = (ms: number | null): string | null => {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  let rest = Math.floor(ms / 1000);
  const days = Math.floor(rest / 86_400);
  rest -= days * 86_400;
  const hours = Math.floor(rest / 3_600);
  rest -= hours * 3_600;
  const minutes = Math.floor(rest / 60);
  const seconds = rest - minutes * 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}m` : ''}`;
  if (minutes > 0) return `${minutes}m${seconds > 0 ? `${seconds}s` : ''}`;
  return `${seconds}s`;
};

/** Sample window for the ops-per-second sparkline (5s sampling → ~5 minutes). */
export const OPS_SAMPLE_CAPACITY = 60;

/**
 * Append one ops-per-sec sample to the rolling history. Null/absent samples
 * are dropped (a hole would read as a false dip to zero); non-finite values
 * are clamped to 0. Always returns a new array — the panel keeps it in state.
 */
export const pushOpsSample = (
  history: number[],
  opsPerSec: number | null | undefined,
  capacity: number = OPS_SAMPLE_CAPACITY,
): number[] => {
  if (opsPerSec == null || !Number.isFinite(opsPerSec)) return history;
  const next = [...history, Math.max(0, opsPerSec)];
  return next.length > capacity ? next.slice(next.length - capacity) : next;
};

/**
 * SVG polyline points ("x,y x,y …") for the ops history. The last sample is
 * the freshest and sits at the right edge. Fewer than two finite samples
 * yield a flat baseline so the chart never renders an empty polyline.
 */
export const opsSparklinePoints = (
  history: number[],
  width: number,
  height: number,
): string => {
  const pad = 2;
  const values = history.filter((v) => Number.isFinite(v));
  // Fewer than two points cannot form a line — render the flat baseline.
  if (values.length < 2) return `0,${height - pad} ${width},${height - pad}`;
  const max = Math.max(...values, 1);
  const stepX = width / (values.length - 1);
  return values
    .map((v, i) => {
      const x = Math.round(i * stepX * 100) / 100;
      const y = height - pad - (v / max) * (height - pad * 2);
      return `${x},${Math.round(y * 100) / 100}`;
    })
    .join(' ');
};
