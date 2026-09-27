// Filename sanitizer: keep the Suno title as close to exact as the filesystem
// allows. `#`, apostrophes, parentheses, `&`, etc. stay. Characters that
// Windows / Chrome downloads reject are mapped to lookalikes (or dropped)
// instead of stripping all punctuation.
const FILE_UNSAFE = /[<>:"/\\|?*\u0000-\u001f]/g;
const FILE_REPLACEMENTS = {
  "<": "",
  ">": "",
  ":": "：",
  '"': "'",
  "/": "-",
  "\\": "-",
  "|": "-",
  "?": "？",
  "*": "＊",
};

function sanitizeTitle(title, fallback = "untitled") {
  const cleaned = String(title || "")
    .replace(FILE_UNSAFE, (ch) => FILE_REPLACEMENTS[ch] ?? "")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
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
// The folder is sanitized to stay inside Downloads; the title keeps punctuation
// that filesystems allow (including #) and maps * / ? / : to lookalikes.
// chrome.downloads.download() appends the extension and creates the subfolder
// under the user's Downloads directory.
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
