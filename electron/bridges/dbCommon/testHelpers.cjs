"use strict";

// Shared bridge-test helper: poll an in-memory `pushes` array until the given
// phase lands (backup/restore jobs push progress asynchronously via
// quolldesk:db:jobProgress). `since` waits for a LATER occurrence
// (index >= since) when the same phase can fire more than once.
function waitForPush(pushes, phase, timeoutMs = 3000, since = 0) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const hit = pushes.find((p, i) => i >= since && p.phase === phase);
      if (hit) return resolve(hit);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`timeout waiting for phase '${phase}'; pushes=${JSON.stringify(pushes)}`));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

module.exports = { waitForPush };
