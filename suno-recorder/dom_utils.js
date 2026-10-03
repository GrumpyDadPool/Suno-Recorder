// Shared visibility helper (loaded before content.js).
function isShown(el) {
  if (!el || typeof el.getBoundingClientRect !== "function") return false;
  const rect = el.getBoundingClientRect();
  const win = typeof window !== "undefined" ? window : null;
  if (rect.width <= 1 || rect.height <= 1 || rect.bottom <= 0) return false;
  if (win && Number.isFinite(win.innerHeight) && rect.top >= win.innerHeight) return false;
  if (win && typeof win.getComputedStyle === "function") {
    const style = win.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const opacity = parseFloat(style.opacity);
    if (Number.isFinite(opacity) && opacity <= 0) return false;
  }
  return true;
}

if (typeof module !== "undefined") {
  module.exports = { isShown };
}
