"use strict";

const { randomUUID } = require("node:crypto");

const { errorEnvelope, DB_ERROR_CODES } = require("./resultEnvelope.cjs");

// One active dump/restore job per connection; the map holds its jobId.
const activeJobs = new Map();

/**
 * Reserve the single job slot for one connection. Resolves to
 * `{ error }` (the ready-to-return envelope) when a job is already running,
 * otherwise `{ jobId, release }` — release() clears the slot and is safe to
 * call more than once (it only ever clears its own jobId).
 */
function reserveDbJob(connectionId, busyMessage) {
  if (activeJobs.has(connectionId)) {
    return { error: errorEnvelope(DB_ERROR_CODES.INVALID_PARAMS, busyMessage) };
  }
  const jobId = randomUUID();
  activeJobs.set(connectionId, jobId);
  return {
    jobId,
    release: () => {
      if (activeJobs.get(connectionId) === jobId) activeJobs.delete(connectionId);
    },
  };
}

module.exports = { reserveDbJob };
