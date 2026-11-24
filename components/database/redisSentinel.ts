/**
 * Redis Sentinel topology parsers: SENTINEL masters / SENTINEL slaves reply
 * as an array of entries, each entry a flat [key, value, key, value…] list.
 * Bridge serialization may turn values into strings — tolerant parsing.
 */

export interface SentinelEntry {
  name: string;
  ip: string;
  port: string;
  flags: string;
  numSlaves: string;
}

/** Flatten one [k, v, k, v…] entry into an object. */
const pairEntryToObject = (entry: unknown[]): Record<string, string> => {
  const obj: Record<string, string> = {};
  for (let i = 0; i + 1 < entry.length; i += 2) {
    obj[String(entry[i])] = String(entry[i + 1]);
  }
  return obj;
};

/** Parse SENTINEL masters/slaves reply into typed entries (unknown shapes → []). */
export const parseSentinelEntries = (reply: unknown): SentinelEntry[] => {
  if (!Array.isArray(reply)) return [];
  return reply
    .filter((entry): entry is unknown[] => Array.isArray(entry))
    .map((entry) => {
      const obj = pairEntryToObject(entry);
      return {
        name: obj.name ?? '',
        ip: obj.ip ?? '',
        port: obj.port ?? '',
        flags: obj.flags ?? '',
        numSlaves: obj['num-slaves'] ?? '',
      };
    });
};
