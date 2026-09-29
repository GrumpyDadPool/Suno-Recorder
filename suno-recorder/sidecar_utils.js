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

function normalizeLyrics(text) {
  const lines = String(text || "")
    .replace(/\u00a0/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+$/g, ""));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const value = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!value) return "";
  if (/^(instrumental|no lyrics available|no lyrics)\.?$/i.test(value)) return "";
  return value;
}

if (typeof module !== "undefined") {
  module.exports = {
    isSunoCoverUrl,
    coverAltTitle,
    imageExtension,
    normalizeLyrics,
  };
}
