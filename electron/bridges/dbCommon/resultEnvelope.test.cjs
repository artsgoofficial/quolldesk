const test = require("node:test");
const assert = require("node:assert/strict");
const {
  okEnvelope, errorEnvelope, DB_ERROR_CODES, classifyDriverError, sanitizeMessage,
} = require("./resultEnvelope.cjs");

test("envelopes wrap data and errors", () => {
  assert.deepEqual(okEnvelope({ a: 1 }), { ok: true, data: { a: 1 } });
  const bad = errorEnvelope(DB_ERROR_CODES.QUERY_ERROR, "boom", { detail: "x" });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "QUERY_ERROR");
  assert.equal(bad.error.message, "boom");
  assert.equal(bad.error.detail, "x");
});

test("classifyDriverError maps common codes", () => {
  assert.equal(classifyDriverError({ code: "ECONNREFUSED" }), DB_ERROR_CODES.NETWORK_UNREACHABLE);
  assert.equal(classifyDriverError({ code: "ETIMEDOUT" }), DB_ERROR_CODES.CONNECT_TIMEOUT);
  assert.equal(classifyDriverError({ code: "ENOTFOUND" }), DB_ERROR_CODES.NETWORK_UNREACHABLE);
  assert.equal(classifyDriverError(new Error("Access denied for user 'x'@'h'")), DB_ERROR_CODES.AUTH_FAILED);
  assert.equal(classifyDriverError(new Error("WRONGPASS invalid username-password")), DB_ERROR_CODES.AUTH_FAILED);
  assert.equal(classifyDriverError(new Error("NOAUTH Authentication required")), DB_ERROR_CODES.AUTH_FAILED);
  assert.equal(classifyDriverError(new Error("password authentication failed for user \"u\"")), DB_ERROR_CODES.AUTH_FAILED);
  assert.equal(classifyDriverError(new Error("certificate verify failed")), DB_ERROR_CODES.TLS_FAILED);
  assert.equal(classifyDriverError(new Error("syntax error at or near")), DB_ERROR_CODES.QUERY_ERROR);
  assert.equal(classifyDriverError(new Error("ER_ACCESS_DENIED_ERROR: whatever")), DB_ERROR_CODES.PERMISSION_DENIED);
  assert.equal(classifyDriverError(new Error("mystery")), DB_ERROR_CODES.INTERNAL);
  assert.equal(classifyDriverError(undefined), DB_ERROR_CODES.INTERNAL);
});

test("sanitizeMessage strips credential fragments", () => {
  assert.equal(sanitizeMessage("connect redis://user:secretpw@h:6379 failed"), "connect redis://[credentials]@h:6379 failed");
  assert.equal(sanitizeMessage("auth failed with password=abc123 on host"), "auth failed with password=[redacted] on host");
  assert.equal(sanitizeMessage("plain message"), "plain message");
});
