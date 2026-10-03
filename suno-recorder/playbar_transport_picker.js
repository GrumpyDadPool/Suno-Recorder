// Shared play-bar transport selection (loaded before content.js).
function resolveIsShown(deps) {
  if (deps && deps.isShown) return deps.isShown;
  if (typeof isShown === "function") return isShown;
  return () => true;
}

function playbarTransportButtonMatches(btn) {
  const label = (btn.getAttribute("aria-label") || "").toLowerCase();
  if (/\b(skip|next|previous|prev|title|shuffle|repeat|volume|queue|like|share)\b/.test(label)) return false;
  return /\b(play|pause)\b/.test(label);
}

function findVisiblePlaybarAnchor(doc, deps) {
  const documentRef = doc || (typeof document !== "undefined" ? document : null);
  if (!documentRef) return null;
  const isShownFn = resolveIsShown(deps);
  const titleNodes = Array.from(documentRef.querySelectorAll('[aria-label*="Playbar: Title"]'));
  const title = titleNodes.find(isShownFn);
  if (title) return title;
  const links = Array.from(documentRef.querySelectorAll('a[aria-label*="Playbar"][href*="/song/"]'));
  return links.find(isShownFn) || null;
}

function collectTitleScopeTransportButtons(doc, deps) {
  const documentRef = doc || (typeof document !== "undefined" ? document : null);
  if (!documentRef) return [];
  const isShownFn = resolveIsShown(deps);
  const titleNode = findVisiblePlaybarAnchor(documentRef, deps);
  let scope = titleNode ? titleNode.parentElement : null;
  for (let depth = 0; depth < 6 && scope; depth += 1) {
    const rect = scope.getBoundingClientRect();
    if (rect.height > 240) break;
    const local = Array.from(scope.querySelectorAll("button[aria-label]")).filter(playbarTransportButtonMatches);
    if (local.some(isShownFn)) return local;
    scope = scope.parentElement;
  }
  return [];
}

function collectPlaybarTransportButtons(doc, deps) {
  const documentRef = doc || (typeof document !== "undefined" ? document : null);
  if (!documentRef) return [];
  const isShownFn = resolveIsShown(deps);
  const buttons = Array.from(documentRef.querySelectorAll("button[aria-label]"));
  const labelled = buttons.filter((btn) => {
    const label = (btn.getAttribute("aria-label") || "").toLowerCase();
    if (!label.includes("playbar")) return false;
    return playbarTransportButtonMatches(btn);
  });
  const scoped = collectTitleScopeTransportButtons(documentRef, deps);
  const anchor = findVisiblePlaybarAnchor(documentRef, deps);
  // A visible on-screen title means the live bar is title-scoped. Stale
  // "Playbar: Play" shells elsewhere in the DOM can still pass isShown.
  if (anchor && scoped.some(isShownFn)) return scoped;

  if (labelled.some(isShownFn)) return labelled;
  if (scoped.some(isShownFn)) return scoped;
  if (labelled.length) return labelled;
  return scoped;
}

function pickPlaybarTransportButton(candidates, preferPause, deps) {
  const isShownFn = deps && deps.isShown;
  const buttonShowsPause = deps && deps.buttonShowsPause;
  if (!candidates.length) return null;
  const shown = isShownFn ? candidates.filter((btn) => isShownFn(btn)) : candidates;
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
  module.exports = {
    pickPlaybarTransportButton,
    playbarTransportButtonMatches,
    collectTitleScopeTransportButtons,
    collectPlaybarTransportButtons,
    findVisiblePlaybarAnchor,
    resolveIsShown,
  };
}
