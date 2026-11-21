"use strict";

/**
 * Shared helpers for the SQL backup/restore feature (mysqlBridge + pgBridge):
 * job-progress push channel, incremental dump file writer, SQL value
 * escaping for INSERT literals, multi-row INSERT statement building and the
 * quote/comment-aware statement splitter used by file restore.
 */

const fs = require("node:fs");

/** Single push channel shared by both dialects (payload carries `dialect`). */
const JOB_PROGRESS_CHANNEL = "quolldesk:db:jobProgress";

/**
 * Push one job-progress event to the renderer that started the job.
 * Returns false when the sender is gone — callers must treat that as an
 * abort signal and stop the job (never push to a destroyed sender).
 */
function pushJobProgress(event, payload) {
  const sender = event?.sender;
  if (!sender || sender.isDestroyed?.()) return false;
  try {
    sender.send(JOB_PROGRESS_CHANNEL, payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * Incremental dump writer. Rows are streamed to disk page by page — the
 * whole dump is never buffered in memory. Captures stream errors so a write
 * after a failure rejects instead of silently losing data.
 */
function createDumpWriter(outFile) {
  const stream = fs.createWriteStream(outFile);
  let streamError = null;
  stream.on("error", (err) => { streamError = err; });
  let ended = false;
  // The underlying open(2) is async: an error thrown before it completes
  // would otherwise race a catch-path unlink (unlink runs, then open creates
  // the file anyway). settle() resolves once the stream has opened or closed.
  const settled = new Promise((resolve) => {
    stream.once("open", () => resolve());
    stream.once("close", () => resolve());
  });
  return {
    path: outFile,
    async write(chunk) {
      if (ended) throw new Error("dump writer already closed");
      if (streamError) throw streamError;
      if (!stream.write(chunk)) {
        await new Promise((resolve) => stream.once("drain", resolve));
      }
      if (streamError) throw streamError;
    },
    /** Flush and close. Resolves once the file is fully on disk. */
    end() {
      if (ended) return Promise.resolve();
      ended = true;
      return new Promise((resolve, reject) => stream.end(() => (streamError ? reject(streamError) : resolve())));
    },
    /** Abort path: stop accepting writes and release the fd (delete stays with the caller). */
    destroy() {
      if (ended) return;
      ended = true;
      try { stream.destroy(); } catch { /* ignore */ }
    },
    /** Resolves once the fd is open or the stream is closed — await before unlink. */
    async settle() { await settled; },
  };
}

/**
 * Render one value as a SQL literal for an INSERT statement.
 * null/undefined → NULL; finite numbers → bare; booleans → TRUE/FALSE;
 * Date → local 'YYYY-MM-DD HH:MM:SS'; Buffer → hex (X'..' for mysql,
 * '\x..'::bytea for pg); everything else → single-quoted string.
 *
 * Escaping (kept deliberately simple, documented limitations):
 * - quotes `'` → `''` always (both dialects).
 * - backslash `\` → `\\` ONLY when escapeBackslash (MySQL) — PostgreSQL with
 *   standard_conforming_strings=on treats backslashes literally, so doubling
 *   them would corrupt pg values.
 * - binary columns and non-finite numbers fall into the string path (hex or
 *   String(value)); NaN/Infinity therefore dump as their string form.
 */
function sqlLiteral(value, { escapeBackslash = false } = {}) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return `'${String(value)}'`;
    return String(value);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    const pad = (n) => String(n).padStart(2, "0");
    const text = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ` +
      `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
    return `'${text}'`;
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    const hex = value.toString("hex").toUpperCase();
    return escapeBackslash ? `X'${hex}'` : `'\\x${hex}'::bytea`;
  }
  if (typeof value === "object") {
    // pg parses json/jsonb columns into JS objects (arrays too for _text
    // columns): JSON round-trip preserves them as valid literals. Plain
    // String() would emit '[object Object]' — corrupting json columns.
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  }
  let text = String(value);
  if (escapeBackslash) text = text.replace(/\\/g, "\\\\");
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * Escape one string for interpolation into a single-quoted SQL literal
 * (backslash doubling ONLY for mysql — see sqlLiteral's escapeBackslash).
 * For information_schema predicates where placeholders are inconvenient.
 */
function escapeSqlString(value, { escapeBackslash = false } = {}) {
  let text = String(value);
  if (escapeBackslash) text = text.replace(/\\/g, "\\\\");
  return text.replace(/'/g, "''");
}

/**
 * Build multi-row INSERT statements (≤ batchSize rows each, default 100).
 * `tableRef` and `quote` are dialect-specific (already-quoting identifier
 * helper); `rows` is an array of value arrays in `columns` order; `literal`
 * is a bound sqlLiteral. Returns [] for empty rows.
 */
function buildInsertStatements({ tableRef, quote, columns, rows, literal, batchSize = 100 }) {
  if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(columns) || columns.length === 0) return [];
  const colList = columns.map((c) => quote(String(c))).join(", ");
  const statements = [];
  for (let start = 0; start < rows.length; start += batchSize) {
    const chunk = rows.slice(start, start + batchSize);
    const values = chunk.map((row) => `(${row.map(literal).join(", ")})`).join(",\n  ");
    statements.push(`INSERT INTO ${tableRef} (${colList}) VALUES\n  ${values};`);
  }
  return statements;
}

/**
 * Split a SQL script into executable statements. Splits on `;` while
 * respecting:
 * - '...' string literals with '' doubling (and backslash escapes when
 *   `backslashEscapes`, i.e. MySQL — pg with standard_conforming_strings
 *   treats backslashes literally, so the flag must match the dump dialect);
 * - "..." quoted identifiers with "" doubling;
 * - `--` line comments (comment text is DROPPED, not kept);
 * - block comments (slash-star pairs, dropped as well).
 * Empty / comment-only statements are skipped. Delimiter-based dumps
 * (routines/procedures via DELIMITER) are NOT supported in v1 — a stored
 * procedure body containing `;` splits incorrectly (documented limitation).
 * Returns trimmed statement strings without their trailing `;`.
 */
function splitSqlStatements(text, { backslashEscapes = false } = {}) {
  const statements = [];
  let current = "";
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    const next = i + 1 < n ? text[i + 1] : "";
    if (ch === "'") {
      current += ch;
      i += 1;
      while (i < n) {
        if (backslashEscapes && text[i] === "\\" && i + 1 < n) {
          current += text[i] + text[i + 1];
          i += 2;
          continue;
        }
        if (text[i] === "'") {
          if (text[i + 1] === "'") { current += "''"; i += 2; continue; }
          current += "'";
          i += 1;
          break;
        }
        current += text[i];
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      current += ch;
      i += 1;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { current += '""'; i += 2; continue; }
          current += '"';
          i += 1;
          break;
        }
        current += text[i];
        i += 1;
      }
      continue;
    }
    if (ch === "-" && next === "-") {
      while (i < n && text[i] !== "\n") i += 1; // drop comment, keep the newline char for the next loop
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === ";") {
      statements.push(current);
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  statements.push(current);
  return statements.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Best-effort partial-file cleanup after a failed dump: never throws.
 */
function unlinkQuietly(filePath) {
  try { fs.unlink(filePath, () => {}); } catch { /* ignore */ }
}

// Progress is pushed every N executed restore statements (kept coarse so a
// multi-thousand-statement restore does not flood the push channel).
const RESTORE_PROGRESS_EVERY = 25;

/**
 * Sender-guarded pusher for one backup/restore job: `push(payload)` stamps
 * jobId + dialect and no-ops (returns false) once the renderer that started
 * the job is gone; `senderAlive()` is the same check for abort decisions.
 */
function makeJobPusher(event, jobId, dialect) {
  const senderAlive = () => Boolean(event?.sender && !event.sender.isDestroyed?.());
  return {
    senderAlive,
    push: (payload) => (senderAlive() ? pushJobProgress(event, { jobId, dialect, ...payload }) : false),
  };
}

/**
 * Abort path for a failed dump: stop accepting writes, release the fd and
 * delete the partial file. The settle() await closes the open/unlink race
 * (the stream may still be opening when the error fires).
 */
async function abortDump(writer, outFile) {
  writer.destroy();
  await writer.settle();
  unlinkQuietly(outFile);
}

/**
 * Execute pre-split restore statements sequentially via `exec(statement)`.
 * Already-executed statements stay applied when a later statement fails
 * (no wrapping transaction — documented). Progress pushes every
 * RESTORE_PROGRESS_EVERY statements and the run stops at the first error.
 * Never throws: failures surface as a phase:'error' jobProgress push.
 */
async function runSequentialRestore({ event, jobId, dialect, statements, exec }) {
  const { senderAlive, push } = makeJobPusher(event, jobId, dialect);
  const total = statements.length;
  let done = 0;
  try {
    if (!push({ phase: "restore", done: 0, total })) throw new Error("renderer gone — restore aborted");
    for (const statement of statements) {
      await exec(statement);
      done += 1;
      if (done % RESTORE_PROGRESS_EVERY === 0) {
        if (!push({ phase: "restore", done, total })) throw new Error("renderer gone — restore aborted");
      }
    }
    push({ phase: "done", message: `${done} statements executed` });
  } catch (err) {
    if (senderAlive()) {
      const message = err?.message || "restore failed";
      push({ phase: "error", index: done, error: message, message });
    }
  }
}

module.exports = {
  JOB_PROGRESS_CHANNEL,
  pushJobProgress,
  createDumpWriter,
  sqlLiteral,
  escapeSqlString,
  buildInsertStatements,
  splitSqlStatements,
  unlinkQuietly,
  makeJobPusher,
  abortDump,
  runSequentialRestore,
};
