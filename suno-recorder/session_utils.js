// Stale-session watchdog for the popup. A session is stuck only when we have
// not seen a heartbeat (or start timestamp) for staleMs. Discovery and the
// first-track hunt can run for many minutes with an empty queue — that is not
// evidence the content script died.
function isWatchdogStatus(status) {
  return status === "starting" || status === "collecting" || status === "capturing";
}

function isSessionStale(state, heartbeat, now, staleMs) {
  if (!state || !isWatchdogStatus(state.status)) return false;
  const startedAt = Number(state.startedAt) || 0;
  const lastBeat = Number(heartbeat) || 0;
  const lastAlive = Math.max(startedAt, lastBeat);
  if (!lastAlive) return true;
  return now - lastAlive > staleMs;
}

if (typeof module !== "undefined") {
  module.exports = { isSessionStale };
}
