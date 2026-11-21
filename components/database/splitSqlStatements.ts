/**
 * Statement splitter for the query editor: the workbench runs each statement
 * separately so every SQL gets its own result tab. Splits on top-level `;`
 * only — quoted strings/identifiers, comments and (pg) dollar-quoted bodies
 * never produce a split. Escapes are dialect-aware: mysql honors backslash
 * escapes and `#` line comments; postgresql uses quote doubling, dollar
 * quoting and `--`/`/* * /` comments only.
 */
export function splitSqlStatements(sql: string, dialect: 'mysql' | 'postgresql'): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;
  // Whether the current segment holds executable SQL — a segment that is only
  // comments/whitespace (`SELECT 1; -- note\n; SELECT 2`) must not run.
  let hasCode = false;

  // Length of a pg dollar-quote tag ($, $tag$) opening at i, or 0.
  const dollarTagLength = (): number => {
    if (sql[i] !== '$') return 0;
    let j = i + 1;
    // A tag never starts with a digit (pg: identifier rules keep $1 a placeholder).
    if (sql[j] >= '0' && sql[j] <= '9') return 0;
    while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j += 1;
    return sql[j] === '$' ? j - i + 1 : 0;
  };

  while (i < sql.length) {
    const ch = sql[i];
    const next = i + 1 < sql.length ? sql[i + 1] : '';

    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (dialect === 'mysql' && ch === '#') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      hasCode = true;
      i += 1;
      while (i < sql.length) {
        if (dialect === 'mysql' && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === ch) {
          // Doubled quote = escaped quote, keep scanning.
          if (sql[i + 1] === ch) { i += 2; continue; }
          break;
        }
        i += 1;
      }
      i += 1;
      continue;
    }
    if (dialect === 'postgresql') {
      const tag = dollarTagLength();
      if (tag) {
        const opener = sql.slice(i, i + tag);
        const end = sql.indexOf(opener, i + tag);
        i = end === -1 ? sql.length : end + tag;
        continue;
      }
    }
    if (ch === ';') {
      const statement = sql.slice(start, i).trim();
      if (statement && hasCode) statements.push(statement);
      start = i + 1;
      hasCode = false;
      i += 1;
      continue;
    }
    if (!/\s/.test(ch)) hasCode = true;
    i += 1;
  }

  const tail = sql.slice(start).trim();
  if (tail && hasCode) statements.push(tail);
  return statements;
}
