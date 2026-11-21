"use strict";

// Read-only gate for the database_query capability: statement-level keyword
// validation (fast, clear errors). The service additionally wraps execution in
// a READ ONLY transaction, which is the authoritative enforcement (it blocks
// writes even under EXPLAIN ANALYZE and inside CTEs).

const READ_ONLY_KEYWORDS = Object.freeze({
  mysql: ["select", "show", "explain", "describe", "desc", "with"],
  postgresql: ["select", "show", "explain", "with", "table", "values"],
});

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/**
 * Split a SQL script into statements on unquoted semicolons. Quote/comment
 * aware: single quotes (doubled-quote escaping, backslash escaping for mysql),
 * double quotes, mysql backticks, -- and /* *\/ comments, and pg dollar-quoting
 * ($tag$ … $tag$) so function bodies with semicolons stay intact.
 */
function splitSqlStatements(sql, dialect) {
  const text = String(sql || "");
  const backslashEscapes = dialect !== "postgresql"; // pg standard_conforming_strings: '\' is literal
  const statements = [];
  let current = "";
  let inSingle = false, inDouble = false, inLineComment = false, inBlockComment = false, dollarTag = null;
  const push = () => { const t = current.trim(); if (t) statements.push(t); current = ""; };
  let i = 0;
  while (i < text.length) {
    const ch = text[i], next = text[i + 1];
    if (inLineComment) { current += ch; if (ch === "\n") inLineComment = false; i += 1; continue; }
    if (inBlockComment) {
      current += ch;
      if (ch === "*" && next === "/") { current += next; i += 2; inBlockComment = false; continue; }
      i += 1; continue;
    }
    if (inSingle) {
      current += ch;
      if (backslashEscapes && ch === "\\") { current += next ?? ""; i += 2; continue; }
      if (ch === "'") { if (next === "'") { current += next; i += 2; continue; } inSingle = false; }
      i += 1; continue;
    }
    if (inDouble) { current += ch; if (ch === '"') inDouble = false; i += 1; continue; }
    if (dollarTag) {
      const close = text.slice(i).match(new RegExp("^" + escapeRegExp(dollarTag)));
      if (close) { current += close[0]; i += close[0].length; dollarTag = null; continue; }
      current += ch; i += 1; continue;
    }
    if (ch === "-" && next === "-") { inLineComment = true; current += "--"; i += 2; continue; }
    if (ch === "/" && next === "*") { inBlockComment = true; current += "/*"; i += 2; continue; }
    if (ch === "'") { inSingle = true; current += ch; i += 1; continue; }
    if (ch === '"') { inDouble = true; current += ch; i += 1; continue; }
    if (ch === "`") { // mysql identifier quoting
      current += ch; i += 1;
      while (i < text.length && text[i] !== "`") { current += text[i]; i += 1; }
      current += "`"; i += 1; continue;
    }
    if (ch === "$" && dialect === "postgresql") {
      const open = text.slice(i).match(/^\$[A-Za-z_]*\$/);
      if (open) { dollarTag = open[0]; current += open[0]; i += open[0].length; continue; }
    }
    if (ch === ";") { push(); i += 1; continue; }
    current += ch; i += 1;
  }
  push();
  return statements;
}

function leadingKeyword(statement) {
  const stripped = statement.replace(/^(?:\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)+/i, "");
  const m = stripped.match(/^[A-Za-z_]+/);
  return m ? m[0].toLowerCase() : null;
}

function truncateSnippet(s) {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 57)}...` : t;
}

/**
 * Validate that every statement in `sql` is read-only for `dialect`.
 * Returns `{ ok: true, statements }` or
 * `{ ok: false, code: "READ_ONLY_VIOLATION" | "INVALID_PARAMS", error }`.
 */
function validateReadOnlySql(dialect, sql) {
  const allowed = READ_ONLY_KEYWORDS[dialect];
  if (!allowed) return { ok: false, code: "INVALID_PARAMS", error: `Unsupported dialect: ${dialect}` };
  const statements = splitSqlStatements(sql, dialect);
  if (!statements.length) return { ok: false, code: "INVALID_PARAMS", error: "SQL statement is empty." };
  for (const stmt of statements) {
    const kw = leadingKeyword(stmt);
    if (!kw || !allowed.includes(kw)) {
      return {
        ok: false,
        code: "READ_ONLY_VIOLATION",
        error: `Statement "${truncateSnippet(stmt)}" is not read-only (keyword: ${kw || "unknown"}). ` +
          "Only SELECT / SHOW / EXPLAIN / DESC / WITH queries are allowed; use database_execute for writes.",
      };
    }
  }
  return { ok: true, statements };
}

// The authoritative write block: engines refuse writes inside READ ONLY
// transactions (mysql 1792 / pg 25006), including under EXPLAIN ANALYZE and
// inside writable CTEs.
function readOnlyTransaction(dialect) {
  return dialect === "postgresql"
    ? { begin: "BEGIN READ ONLY", end: "ROLLBACK" }
    : { begin: "START TRANSACTION READ ONLY", end: "ROLLBACK" };
}

module.exports = { splitSqlStatements, validateReadOnlySql, readOnlyTransaction, READ_ONLY_KEYWORDS };
