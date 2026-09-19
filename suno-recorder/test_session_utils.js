const assert = require("assert");
const { isSessionStale } = require("./session_utils.js");

const STALE_MS = 2 * 60 * 1000;
const now = 1_000_000;

assert.strictEqual(isSessionStale({ status: "idle" }, now, now, STALE_MS), false);
assert.strictEqual(isSessionStale(null, now, now, STALE_MS), false);

// Long library scan, empty queue, but the content script is still heartbeating.
assert.strictEqual(
  isSessionStale(
    { status: "collecting", startedAt: now - 3 * 60 * 1000, queue: [] },
    now - 10_000,
    now,
    STALE_MS
  ),
  false
);

// First-track hunt (including the upward pass) has saved nothing yet.
assert.strictEqual(
  isSessionStale(
    { status: "capturing", startedAt: now - 4 * 60 * 1000, queue: [] },
    now - 15_000,
    now,
    STALE_MS
  ),
  false
);

// Content script actually died — no recent start or heartbeat.
assert.strictEqual(
  isSessionStale(
    { status: "collecting", startedAt: now - 5 * 60 * 1000, queue: [] },
    now - 5 * 60 * 1000,
    now,
    STALE_MS
  ),
  true
);

assert.strictEqual(
  isSessionStale({ status: "capturing", queue: [] }, 0, now, STALE_MS),
  true
);

console.log("session_utils ok");
