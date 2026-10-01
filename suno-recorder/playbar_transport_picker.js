// Shared play-bar transport selection (loaded before content.js).
function pickPlaybarTransportButton(candidates, preferPause, deps) {
  const isShown = deps && deps.isShown;
  const buttonShowsPause = deps && deps.buttonShowsPause;
  if (!candidates.length) return null;
  const shown = isShown ? candidates.filter((btn) => isShown(btn)) : candidates;
  const pool = shown.length ? shown : candidates;
  if (preferPause === true) {
    return pool.find((btn) => buttonShowsPause(btn)) || pool[0];
  }
  if (preferPause === false) {
    return pool.find((btn) => !buttonShowsPause(btn)) || pool[0];
  }
  return (
    pool.find((btn) => (btn.getAttribute("aria-label") || "").toLowerCase().includes("pause")) || pool[0]
  );
}

if (typeof module !== "undefined") {
  module.exports = { pickPlaybarTransportButton };
}
