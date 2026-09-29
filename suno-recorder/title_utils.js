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

// Match key for library rows, skip-done, and one-song selection. Quotes and
// whitespace are normalized before the filename sanitizer so a typed title
// lines up with the row label and the saved file.
function titleKey(title) {
  const normalized = String(title || "")
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return sanitizeTitle(normalized);
}

// Empty target keeps the full list. A target keeps one title: exact key first,
// then a single case-insensitive key. No match returns an empty list.
function selectTargetTitle(titles, targetTitle) {
  const list = Array.isArray(titles) ? titles.filter((title) => titleKey(title)) : [];
  const raw = String(targetTitle || "").trim();
  if (!raw) return list.slice();
  const wanted = titleKey(raw);
  if (!wanted) return list.slice();
  const exact = list.filter((title) => titleKey(title) === wanted);
  if (exact.length) return [exact[0]];
  const folded = wanted.toLowerCase();
  const insensitive = list.filter((title) => titleKey(title).toLowerCase() === folded);
  if (insensitive.length) return [insensitive[0]];
  return [];
}

// True when the bottom play bar is showing a different track than the one
// we started recording. Song id wins when both sides have one; otherwise the
// normalized title. A cleared play bar counts as a change.
function playbarIdentityChanged(initial, current) {
  const initialId = String((initial && initial.id) || "");
  const currentId = String((current && current.id) || "");
  if (initialId && currentId && initialId !== currentId) return true;
  const initialTitle = String((initial && initial.title) || "").trim();
  const currentTitle = String((current && current.title) || "").trim();
  if (initialTitle && currentTitle && titleKey(initialTitle) !== titleKey(currentTitle)) return true;
  if (initialTitle && !currentTitle && !currentId) return true;
  return false;
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
  module.exports = {
    sanitizeTitle,
    sanitizeFolder,
    buildRelativePath,
    titleKey,
    selectTargetTitle,
    playbarIdentityChanged,
  };
}
