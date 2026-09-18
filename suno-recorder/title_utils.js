// Mirrors title_utils.py's sanitize_title() so filenames this extension saves
// match what the Python side (suno_watcher.py) would produce for the same
// title, if it ever needs to re-derive a folder name from a filename.
function sanitizeTitle(title, fallback = "untitled") {
  const cleaned = (title || "").replace(/[^\w\- ]/g, "").trim();
  return cleaned || fallback;
}

// Sanitize a user-supplied "save folder" into a safe RELATIVE subpath under
// Chrome's Downloads directory. Each path segment is run through the same
// filename sanitizer, so illegal characters and any "." / ".." traversal
// segments are stripped (a bare ".." becomes "" and is dropped). Nested
// folders like "Suno/2024" are preserved. Empty input falls back to a default.
function sanitizeFolder(folder, fallback = "Suno Recorder") {
  const segments = String(folder || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => sanitizeTitle(segment, ""))
    .filter(Boolean);
  return segments.join("/") || fallback;
}

// Build the relative download path (no extension) for a track:
//   <saveFolder>/<prefix><sanitized title>
// The folder is sanitized to stay inside Downloads; the title is sanitized the
// same way it always has been. chrome.downloads.download() appends the ".wav"
// extension and creates the subfolder under the user's Downloads directory.
function buildRelativePath(folder, prefix, title, fallback = "Suno Recorder") {
  const dir = sanitizeFolder(folder, fallback);
  const base = `${prefix || ""}${sanitizeTitle(title)}`;
  return `${dir}/${base}`;
}

// Node doesn't have `self`/`window` the way a content script does — this
// export is only used by the Node-based unit test, not by Chrome itself.
if (typeof module !== "undefined") {
  module.exports = { sanitizeTitle, sanitizeFolder, buildRelativePath };
}
