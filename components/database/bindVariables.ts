/**
 * Bind variables (DBeaver-style `${name}` tokens): extract placeholders from a
 * SQL script, collect values, substitute them back as escaped literals. Pure
 * functions — the query editor prompts before running when tokens exist.
 */

import { sqlLiteral } from './csv';

const BIND_TOKEN = /\$\{([^}]+)\}/g;

/** Extract distinct `${name}` variable names in first-appearance order. */
export const extractBindVariables = (sql: string): string[] => {
  const seen = new Set<string>();
  const vars: string[] = [];
  for (const m of sql.matchAll(BIND_TOKEN)) {
    const name = m[1].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    vars.push(name);
  }
  return vars;
};

/** SQL literal for a bound value (escaping via the shared sqlLiteral); blank input means an explicit NULL. */
export const toSqlLiteralValue = (raw: string): string => {
  if (raw.trim() === '') return 'NULL';
  return sqlLiteral(raw);
};

/**
 * Substitute every `${name}` with the bound literal. Variables without a
 * provided value stay untouched (the caller validates before calling).
 */
export const substituteBindVariables = (sql: string, values: Record<string, string>): string =>
  sql.replace(BIND_TOKEN, (_match, rawName: string) => {
    const name = rawName.trim();
    if (!(name in values)) return _match;
    return toSqlLiteralValue(values[name]);
  });
