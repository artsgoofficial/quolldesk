"use strict";

// Read-only gate for the database_query capability: statement-level keyword
// validation (fast, clear errors), shared by the AI/MCP database tools across
// mysql / mariadb / postgresql / mssql / sqlite. The service additionally wraps
// execution in a READ ONLY transaction, which is the authoritative enforcement
// where the engine supports it (it blocks writes even under EXPLAIN ANALYZE and
// inside CTEs). mssql and sqlite have no server-side READ ONLY transaction:
// there the statement-level keyword gate is the primary enforcement and the
// plain BEGIN + ROLLBACK wrapper is the backstop.

// Statement-level keyword gate, per dialect. mariadb shares mysql's array:
// the two engines have the same read-only statement surface.
const MYSQL_READ_ONLY_KEYWORDS = Object.freeze(["select", "show", "explain", "describe", "desc", "with"]);
const READ_ONLY_KEYWORDS = Object.freeze({
  mysql: MYSQL_READ_ONLY_KEYWORDS,
  mariadb: MYSQL_READ_ONLY_KEYWORDS,
  postgresql: ["select", "show", "explain", "with", "table", "values"],
  mssql: ["select", "with", "table", "values"],
  sqlite: ["select", "explain", "pragma", "with", "values", "table"],
});

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/**
 * Split a SQL script into statements on unquoted semicolons. Quote/comment
 * aware: single quotes (doubled-quote escaping, backslash escaping for
 * mysql/mariadb only — pg/sqlite/mssql read '\' as a literal), double quotes,
 * mysql/mariadb backticks, mssql [bracket identifiers] (a doubled `]]` is an
 * escaped `]`), -- and /* *\/ comments, and pg dollar-quoting ($tag$ … $tag$)
 * so function bodies with semicolons stay intact.
 */
function splitSqlStatements(sql, dialect) {
  const text = String(sql || "");
  // Only mysql/mariadb treat '\' as an escape inside strings; pg
  // (standard_conforming_strings), sqlite and mssql read it as a literal.
  const backslashEscapes = dialect === "mysql" || dialect === "mariadb";
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
    if (dialect === "mssql" && ch === "[") {
      // mssql bracket identifier quoting (same consume-until-terminator shape
      // as the mysql backtick handler below): a `;` inside [..] never splits
      // and a doubled `]]` is an escaped `]` (T-SQL quoted-identifier rule).
      current += ch; i += 1;
      while (i < text.length) {
        if (text[i] === "]") {
          if (text[i + 1] === "]") { current += "]]"; i += 2; continue; }
          break;
        }
        current += text[i]; i += 1;
      }
      current += "]"; i += 1; continue;
    }
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

function stripLeadingTrivia(statement) {
  return statement.replace(/^(?:\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)+/i, "");
}

function leadingKeyword(statement) {
  const stripped = stripLeadingTrivia(statement);
  const m = stripped.match(/^[A-Za-z_]+/);
  return m ? m[0].toLowerCase() : null;
}

/**
 * Blank every quoted segment and comment in `text`, preserving character
 * positions and newlines: string literals ('' doubling — sqlite/mssql read
 * '\' as a literal), double quotes, mssql [bracket identifiers] (doubled
 * `]]` escape), and -- / *··* comments each become spaces. Shared residue for
 * both gate checks below, so one scanner owns the quote/comment rules.
 */
function maskQuoted(text) {
  const s = String(text);
  const blanked = [];
  let inSingle = false, inDouble = false, inLineComment = false, inBlockComment = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i], next = s[i + 1];
    if (inLineComment) { blanked.push(ch === "\n" ? "\n" : " "); if (ch === "\n") inLineComment = false; i += 1; continue; }
    if (inBlockComment) {
      if (ch === "*" && next === "/") { inBlockComment = false; blanked.push("  "); i += 2; continue; }
      blanked.push(ch === "\n" ? "\n" : " "); i += 1; continue;
    }
    if (inSingle) {
      if (ch === "'") {
        if (next === "'") { blanked.push("  "); i += 2; continue; }
        inSingle = false; blanked.push(" "); i += 1; continue;
      }
      blanked.push(ch === "\n" ? "\n" : " "); i += 1; continue;
    }
    if (inDouble) {
      if (ch === '"') {
        if (next === '"') { blanked.push("  "); i += 2; continue; }
        inDouble = false; blanked.push(" "); i += 1; continue;
      }
      blanked.push(ch === "\n" ? "\n" : " "); i += 1; continue;
    }
    if (ch === "-" && next === "-") { inLineComment = true; blanked.push("  "); i += 2; continue; }
    if (ch === "/" && next === "*") { inBlockComment = true; blanked.push("  "); i += 2; continue; }
    if (ch === "'") { inSingle = true; blanked.push(" "); i += 1; continue; }
    if (ch === '"') { inDouble = true; blanked.push(" "); i += 1; continue; }
    if (ch === "[") { // [bracket identifier] — contents are a name, never an operator/keyword
      blanked.push(" "); i += 1;
      while (i < s.length) {
        if (s[i] === "]") {
          if (s[i + 1] === "]") { blanked.push("  "); i += 2; continue; }
          break;
        }
        blanked.push(s[i] === "\n" ? "\n" : " "); i += 1;
      }
      blanked.push(" "); i += 1; continue;
    }
    blanked.push(ch); i += 1;
  }
  return blanked.join("");
}

/**
 * Scan `text` for an `=` outside quoted segments and comments (maskQuoted).
 * sqlite reads '\' as a literal, '' / "" are the doubled-quote escapes,
 * [brackets] quote identifiers, and -- / *··* comments are skipped — so
 * `PRAGMA foo('a=b')` stays a read while `PRAGMA user_version=5` is an
 * assignment.
 */
function hasUnquotedEquals(text) {
  return maskQuoted(text).includes("=");
}

function truncateSnippet(s) {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 57)}...` : t;
}

/**
 * mssql's SELECT ... INTO creates a table while leading with SELECT — the
 * keyword gate alone would pass it. Match /\bselect\b[\s\S]*\binto\b/i on the
 * maskQuoted residue, so an "into" inside a string, identifier or comment
 * cannot trigger it. Simple text scan, not a parser: exotic nestings may
 * still trip it, but over-rejecting a rare read is the acceptable trade-off
 * against an approval-bypassing write.
 */
function hasSelectInto(statement) {
  return /\bselect\b[\s\S]*\binto\b/i.test(maskQuoted(statement));
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
          "Only read-only statements (SELECT/WITH and the engine's allowed keywords) are permitted; use database_execute for writes.",
      };
    }
    // sqlite PRAGMA reads come in bare / function-call forms; the assignment
    // form (`PRAGMA user_version=5`, `PRAGMA journal_mode=WAL`) mutates
    // state, and sqlite has no server-side READ ONLY transaction — so the
    // gate itself must reject any unquoted `=` (quoted '=' is data, comments
    // are ignored). Function-form and bare reads stay allowed.
    if (dialect === "sqlite" && kw === "pragma" && hasUnquotedEquals(stripLeadingTrivia(stmt))) {
      return {
        ok: false,
        code: "READ_ONLY_VIOLATION",
        error: `Statement "${truncateSnippet(stmt)}" is not read-only (PRAGMA assignment form; only bare or function-call PRAGMA reads are allowed). ` +
          "Only read-only statements (SELECT/WITH and the engine's allowed keywords) are permitted; use database_execute for writes.",
      };
    }
    // mssql: SELECT ... INTO creates a table while leading with SELECT —
    // mssql has no server-side READ ONLY transaction, so the gate must reject
    // it itself (hasSelectInto: quoted/comment/identifier text cannot
    // false-positive; see there for the residual over-rejection trade-off).
    if (dialect === "mssql" && hasSelectInto(stmt)) {
      return {
        ok: false,
        code: "READ_ONLY_VIOLATION",
        error: `Statement "${truncateSnippet(stmt)}" is not read-only (SELECT ... INTO creates a table). ` +
          "Only read-only statements (SELECT/WITH and the engine's allowed keywords) are permitted; use database_execute for writes.",
      };
    }
  }
  return { ok: true, statements };
}

// The authoritative write block: engines refuse writes inside READ ONLY
// transactions (mysql 1792 / pg 25006), including under EXPLAIN ANALYZE and
// inside writable CTEs. mssql and sqlite have no server-side READ ONLY
// transaction: there the statement-level keyword gate is the primary
// enforcement and the plain BEGIN + ROLLBACK wrapper is the backstop.
function readOnlyTransaction(dialect) {
  if (dialect === "postgresql") return { begin: "BEGIN READ ONLY", end: "ROLLBACK" };
  if (dialect === "mysql" || dialect === "mariadb") return { begin: "START TRANSACTION READ ONLY", end: "ROLLBACK" };
  // No server-side READ ONLY transaction for these engines; the statement-level
  // keyword gate is the primary enforcement, rollback is the backstop.
  if (dialect === "mssql") return { begin: "BEGIN TRANSACTION", end: "ROLLBACK" };
  if (dialect === "sqlite") return { begin: "BEGIN", end: "ROLLBACK" };
  return { begin: "START TRANSACTION READ ONLY", end: "ROLLBACK" };
}

module.exports = { splitSqlStatements, validateReadOnlySql, readOnlyTransaction, READ_ONLY_KEYWORDS };
