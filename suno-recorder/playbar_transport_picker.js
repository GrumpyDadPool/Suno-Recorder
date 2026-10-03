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

function playbarTransportNearAnchor(btn, anchor) {
  if (!btn || !anchor) return true;
  if (typeof btn.getBoundingClientRect !== "function" || typeof anchor.getBoundingClientRect !== "function") {
    return true;
  }
  const a = anchor.getBoundingClientRect();
  const b = btn.getBoundingClientRect();
  if (b.width <= 1 || b.height <= 1) return false;
  const anchorMid = a.top + a.height / 2;
  const btnMid = b.top + b.height / 2;
  return Math.abs(btnMid - anchorMid) <= 96;
}

function findVisiblePlaybarAnchor(doc, deps) {
  const documentRef = doc || (typeof document !== "undefined" ? document : null);
  if (!documentRef) return null;
  const isShownFn = resolveIsShown(deps);
  const nodes = [
    ...Array.from(documentRef.querySelectorAll('[aria-label*="Playbar: Title"]')),
    ...Array.from(documentRef.querySelectorAll('a[aria-label*="Playbar"][href*="/song/"]')),
  ];
  if (!nodes.length) return null;
  const shown = nodes.filter(isShownFn);
  const pool = shown.length ? shown : nodes;
  let anchor = pool[0];
  let anchorTop = anchor.getBoundingClientRect().top;
  for (const node of pool) {
    const top = node.getBoundingClientRect().top;
    if (top > anchorTop) {
      anchor = node;
      anchorTop = top;
    }
  }
  return anchor;
}

function sortPoolByAnchorProximity(pool, anchor) {
  if (!anchor || pool.length <= 1) return pool;
  if (typeof anchor.getBoundingClientRect !== "function") return pool;
  const anchorRect = anchor.getBoundingClientRect();
  const ax = anchorRect.left + anchorRect.width / 2;
  const ay = anchorRect.top + anchorRect.height / 2;
  const distSq = (btn) => {
    if (!btn || typeof btn.getBoundingClientRect !== "function") return Number.POSITIVE_INFINITY;
    const r = btn.getBoundingClientRect();
    const bx = r.left + r.width / 2;
    const by = r.top + r.height / 2;
    return (ax - bx) ** 2 + (ay - by) ** 2;
  };
  return pool.slice().sort((a, b) => distSq(a) - distSq(b));
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
    const near = local.filter((btn) => isShownFn(btn) && playbarTransportNearAnchor(btn, titleNode));
    if (near.length) return near;
    const shown = local.filter(isShownFn);
    if (shown.length) return shown;
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
  const anchor = deps && deps.anchor;
  if (!candidates.length) return null;
  const shown = isShownFn ? candidates.filter((btn) => isShownFn(btn)) : candidates;
  let pool = shown.length ? shown : candidates;
  pool = sortPoolByAnchorProximity(pool, anchor);
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
    playbarTransportNearAnchor,
    resolveIsShown,
  };
}
