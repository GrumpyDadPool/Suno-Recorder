// Mirrors title_utils.py's sanitize_title() so filenames this extension saves
// match what the Python side (suno_watcher.py) would produce for the same
// title, if it ever needs to re-derive a folder name from a filename.
function sanitizeTitle(title, fallback = "untitled") {
  const cleaned = (title || "").replace(/[^\w\- ]/g, "").trim();
  return cleaned || fallback;
}

// Node doesn't have `self`/`window` the way a content script does — this
// export is only used by the Node-based unit test, not by Chrome itself.
if (typeof module !== "undefined") {
  module.exports = { sanitizeTitle };
}
