const test = require("node:test");
const assert = require("node:assert/strict");
const { reserveDbJob } = require("./dbJobs.cjs");
const { DB_ERROR_CODES } = require("./resultEnvelope.cjs");

test("reserve grants a fresh jobId plus a release function", () => {
  const job = reserveDbJob("conn-1", "busy");
  assert.equal(typeof job.jobId, "string");
  assert.equal(job.jobId.length, 36);
  assert.equal(typeof job.release, "function");
  assert.equal(job.error, undefined);
  job.release();
});

test("a second reserve on the same connection is rejected with the busy envelope", () => {
  const first = reserveDbJob("conn-2", "A dump job is already running");
  const second = reserveDbJob("conn-2", "A dump job is already running");
  assert.equal(second.error.ok, false);
  assert.equal(second.error.error.code, DB_ERROR_CODES.INVALID_PARAMS);
  assert.equal(second.error.error.message, "A dump job is already running");
  assert.equal(second.jobId, undefined);
  first.release();
});

test("release frees the slot for the next job", () => {
  const first = reserveDbJob("conn-3", "busy");
  first.release();
  const second = reserveDbJob("conn-3", "busy");
  assert.ok(second.jobId, "slot reopened after release");
  assert.equal(second.error, undefined);
  second.release();
});

test("release is safe to call more than once", () => {
  const job = reserveDbJob("conn-4", "busy");
  job.release();
  job.release();
  const next = reserveDbJob("conn-4", "busy");
  assert.ok(next.jobId);
  next.release();
});

test("a stale release never clears a newer job's slot", () => {
  const stale = reserveDbJob("conn-5", "busy");
  stale.release();
  const current = reserveDbJob("conn-5", "busy");
  stale.release(); // replayed late; must not clobber the newer jobId
  const again = reserveDbJob("conn-5", "busy");
  assert.equal(again.error.ok, false);
  current.release();
});

test("different connections hold independent slots", () => {
  const a = reserveDbJob("conn-6", "busy a");
  const b = reserveDbJob("conn-7", "busy b");
  assert.ok(a.jobId && b.jobId);
  assert.equal(a.jobId !== b.jobId, true);
  a.release();
  b.release();
});
