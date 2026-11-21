"use strict";

const DB_ERROR_CODES = Object.freeze({
  AUTH_FAILED: "AUTH_FAILED",
  CONNECT_TIMEOUT: "CONNECT_TIMEOUT",
  NETWORK_UNREACHABLE: "NETWORK_UNREACHABLE",
  QUERY_ERROR: "QUERY_ERROR",
  TUNNEL_FAILED: "TUNNEL_FAILED",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  INVALID_PARAMS: "INVALID_PARAMS",
  NOT_CONNECTED: "NOT_CONNECTED",
  TLS_FAILED: "TLS_FAILED",
  INTERNAL: "INTERNAL",
});

const okEnvelope = (data) => ({ ok: true, data });

const errorEnvelope = (code, message, extra = undefined) => ({
  ok: false,
  error: { code, message: sanitizeMessage(String(message || "Unknown error")), ...(extra || {}) },
});

const CODE_PATTERNS = [
  { test: (e) => e?.code === "ECONNREFUSED" || e?.code === "ENOTFOUND" || e?.code === "EHOSTUNREACH" || e?.code === "ECONNRESET", code: DB_ERROR_CODES.NETWORK_UNREACHABLE },
  { test: (e) => e?.code === "ETIMEDOUT", code: DB_ERROR_CODES.CONNECT_TIMEOUT },
  { test: (e) => /NOAUTH|WRONGPASS|Access denied for user|password authentication failed|Authentication failed|28P01|28000/i.test(String(e?.message || "")), code: DB_ERROR_CODES.AUTH_FAILED },
  { test: (e) => /ER_ACCESS_DENIED_ERROR|access denied/i.test(String(e?.message || "")) , code: DB_ERROR_CODES.PERMISSION_DENIED },
  { test: (e) => /certificate|ssl|tls/i.test(String(e?.message || "")) , code: DB_ERROR_CODES.TLS_FAILED },
  { test: (e) => /syntax error|SQL syntax|ER_PARSE_ERROR|ER_NO_SUCH_TABLE|does not exist|relation .* does not exist|Unknown column/i.test(String(e?.message || "")), code: DB_ERROR_CODES.QUERY_ERROR },
  // Message-based timeout detection runs LAST so statement/message errors
  // (syntax errors, missing tables, …) classify first; driver-level
  // inactivity timeouts (e.g. mysql2 PROTOCOL_SEQUENCE_TIMEOUT) still map
  // to CONNECT_TIMEOUT here.
  { test: (e) => /timed?\s*out/i.test(String(e?.message || "")), code: DB_ERROR_CODES.CONNECT_TIMEOUT },
];

function classifyDriverError(err) {
  for (const pattern of CODE_PATTERNS) {
    try { if (pattern.test(err)) return pattern.code; } catch { /* ignore */ }
  }
  return DB_ERROR_CODES.INTERNAL;
}

function sanitizeMessage(message) {
  return String(message)
    .replace(/:\/\/[^/@\s]+:[^/@\s]+@/g, "://[credentials]@")
    .replace(/(password\s*[=:]\s*)(\S+)/gi, "$1[redacted]");
}

// Grid/query cells are truncated at 4KB before crossing IPC.
const CELL_TRUNCATE_BYTES = 4 * 1024;

/**
 * Serialize one driver cell for IPC: null → null, Date → ISO string,
 * objects → JSON text, everything else → string; capped at
 * CELL_TRUNCATE_BYTES. Shared by both SQL bridges' result shaping.
 */
function serializeCellValue(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return text.length > CELL_TRUNCATE_BYTES ? text.slice(0, CELL_TRUNCATE_BYTES) : text;
  }
  const text = String(value);
  return text.length > CELL_TRUNCATE_BYTES ? text.slice(0, CELL_TRUNCATE_BYTES) : text;
}

module.exports = {
  okEnvelope, errorEnvelope, DB_ERROR_CODES, classifyDriverError, sanitizeMessage,
  serializeCellValue,
};
