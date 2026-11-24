/**
 * Redis big-key analysis (sampling-based): SCAN pages collect the key
 * universe (capped), a spaced sample gets TYPE + MEMORY USAGE probes, results
 * sort into a top list. Parsers here are pure; the panel drives runCommand.
 */

export interface BigKeyRow {
  key: string;
  type: string;
  memoryBytes: number;
}

/** Parse a SCAN reply (bridge-serialized): [cursor, keys[]]. */
export const parseScanReply = (reply: unknown): { cursor: string; keys: string[] } => {
  if (!Array.isArray(reply)) return { cursor: '0', keys: [] };
  const [cursor, keys] = reply;
  return {
    cursor: String(cursor ?? '0'),
    keys: Array.isArray(keys) ? keys.map((k) => String(k)) : [],
  };
};

/** Evenly-spaced sample of at most `cap` keys (deterministic, order kept). */
export const pickSample = (keys: string[], cap: number): string[] => {
  if (keys.length <= cap) return keys;
  const step = keys.length / cap;
  const out: string[] = [];
  for (let i = 0; i < cap; i += 1) out.push(keys[Math.floor(i * step)]);
  return out;
};

/** TYPE reply → type string (tolerant of unexpected shapes). */
export const parseTypeReply = (reply: unknown): string =>
  typeof reply === 'string' ? reply : reply == null ? 'none' : String(reply);

/** MEMORY USAGE reply → byte count (0/NaN tolerated as 0). */
export const parseMemoryUsageReply = (reply: unknown): number => {
  const n = Number(reply);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Human byte rendering (KB/MB/GB, one decimal). */
export const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};
