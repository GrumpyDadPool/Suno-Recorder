// Lyrics text and cover-image checks shared by the content script and node tests.
// Song artwork on the library page is served from cdn2.suno.ai. Profile images
// and the site mark are not.

function isSunoCoverUrl(src) {
  let url;
  try {
    url = new URL(String(src || ""), "https://suno.com");
  } catch (_) {
    return false;
  }
  if (url.protocol !== "https:" || url.hostname !== "cdn2.suno.ai") return false;
  const path = url.pathname.toLowerCase();
  if (/(saura|avatar|logo|favicon|apple-touch)/.test(path)) return false;
  return /\.(jpe?g|png|webp)$/.test(path);
}

// Alt text observed on the open song panel ("Image for …") and on library
// rows ("… artwork"). Anything else is not that track's cover label.
function coverAltTitle(alt) {
  const raw = String(alt || "").replace(/\s+/g, " ").trim();
  if (/^image for /i.test(raw)) return raw.replace(/^image for /i, "").trim();
  if (/ artwork$/i.test(raw)) return raw.replace(/ artwork$/i, "").trim();
  return "";
}

function imageExtension(mime, src, bytes) {
  const header = bytes instanceof Uint8Array ? bytes : new Uint8Array();
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "jpg";
  if (
    header.length >= 8 &&
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47
  ) {
    return "png";
  }
  if (
    header.length >= 12 &&
    header[0] === 0x52 &&
    header[1] === 0x49 &&
    header[2] === 0x46 &&
    header[3] === 0x46 &&
    header[8] === 0x57 &&
    header[9] === 0x45 &&
    header[10] === 0x42 &&
    header[11] === 0x50
  ) {
    return "webp";
  }
  const type = String(mime || "").split(";")[0].trim().toLowerCase();
  if (type === "image/jpeg" || type === "image/jpg") return "jpg";
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  const path = String(src || "").split("?")[0].toLowerCase();
  if (path.endsWith(".png")) return "png";
  if (path.endsWith(".webp")) return "webp";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "jpg";
  return "";
}

const NO_LYRICS_TEXT =
  /^(instrumental|no lyrics available|no lyrics|this song is instrumental|lyrics unavailable)\.?$/i;
const COVER_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

function normalizeLyrics(text) {
  const lines = String(text || "")
    .replace(/\u00a0/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+$/g, ""));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length && /^lyrics$/i.test(lines[0].trim())) lines.shift();
  while (lines.length && !lines[0].trim()) lines.shift();
  const value = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!value) return "";
  if (NO_LYRICS_TEXT.test(value.replace(/\s+/g, " ").trim())) return "";
  return value;
}

// Styles go on top of the same text file. Either part alone is still worth
// saving. Both empty is not a file.
function composeSidecarText(styles, lyrics) {
  const styleText = String(styles || "")
    .replace(/\u00a0/g, " ")
    .trim();
  const lyricText = String(lyrics || "")
    .replace(/\u00a0/g, " ")
    .trim();
  if (styleText && lyricText) return `${styleText}\n\n${lyricText}`;
  return styleText || lyricText;
}

// "lyrics" is real song text. "absent" is a placeholder that says the song has
// no lyrics. "empty" means this read did not show either one yet.
function lyricsPresence(text) {
  const compact = String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact || /^lyrics$/i.test(compact)) return "empty";
  if (normalizeLyrics(text)) return "lyrics";
  const withoutLabel = compact.replace(/^lyrics\s+/i, "").trim();
  if (NO_LYRICS_TEXT.test(compact) || NO_LYRICS_TEXT.test(withoutLabel)) return "absent";
  return "empty";
}

// Decide what a Lyrics and covers run still needs to download. A Chrome
// "Title (1)" uniquify name is not the saved song. An empty file is not saved
// lyrics or a saved cover. Audio on the recorded-song list is not consulted.
function planSidecarSave(files, relativeBase) {
  const relative = String(relativeBase || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  let hasLyrics = false;
  let hasCover = false;
  if (relative) {
    for (const file of Array.isArray(files) ? files : []) {
      const full = String((file && file.filename) || "")
        .replace(/\\/g, "/")
        .toLowerCase();
      const slash = full.lastIndexOf("/");
      const base = slash >= 0 ? full.slice(slash + 1) : full;
      const dot = base.lastIndexOf(".");
      if (dot <= 0) continue;
      const ext = base.slice(dot + 1);
      const stemPath = `${slash >= 0 ? full.slice(0, slash + 1) : ""}${base.slice(0, dot)}`;
      if (stemPath !== relative && !stemPath.endsWith(`/${relative}`)) continue;
      const bytes = file && typeof file.bytes === "number" ? file.bytes : -1;
      if (bytes === 0) continue;
      if (ext === "txt") hasLyrics = true;
      else if (COVER_EXTENSIONS.has(ext)) hasCover = true;
    }
  }
  return {
    hasLyrics,
    hasCover,
    skipSong: hasLyrics && hasCover,
    saveLyrics: !hasLyrics,
    saveCover: !hasCover,
  };
}

if (typeof module !== "undefined") {
  module.exports = {
    isSunoCoverUrl,
    coverAltTitle,
    imageExtension,
    normalizeLyrics,
    lyricsPresence,
    composeSidecarText,
    planSidecarSave,
  };
}
