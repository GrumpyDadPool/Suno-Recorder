const assert = require("assert");
const {
  isSunoCoverUrl,
  coverAltTitle,
  imageExtension,
  normalizeLyrics,
  lyricsPresence,
  composeSidecarText,
  planSidecarSave,
} = require("./sidecar_utils.js");

const SAMPLE = "Sample Track";

assert.strictEqual(isSunoCoverUrl("https://cdn2.suno.ai/image_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpeg"), true);
assert.strictEqual(isSunoCoverUrl("https://cdn2.suno.ai/image_large_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpeg"), true);
assert.strictEqual(isSunoCoverUrl("https://cdn2.suno.ai/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpeg"), true);
assert.strictEqual(isSunoCoverUrl("https://cdn2.suno.ai/image_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpeg?width=100"), true);
assert.strictEqual(isSunoCoverUrl("https://cdn1.suno.ai/sAura9.jpg"), false);
assert.strictEqual(isSunoCoverUrl("https://cdn1.suno.ai/978311b7.webp"), false);
assert.strictEqual(isSunoCoverUrl("https://cdn2.suno.ai/logo.png"), false);
assert.strictEqual(isSunoCoverUrl("https://example.com/image_song.jpeg"), false);

assert.strictEqual(coverAltTitle(`Image for ${SAMPLE}`), SAMPLE);
assert.strictEqual(coverAltTitle(`${SAMPLE} artwork`), SAMPLE);
assert.strictEqual(coverAltTitle("User avatar"), "");
assert.strictEqual(coverAltTitle(""), "");

assert.strictEqual(imageExtension("image/jpeg", "", new Uint8Array([0xff, 0xd8, 0xff, 0x00])), "jpg");
assert.strictEqual(imageExtension("image/png", "", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), "png");
assert.strictEqual(
  imageExtension("", "https://cdn2.suno.ai/image_x.webp", new Uint8Array()),
  "webp"
);
assert.strictEqual(imageExtension("text/plain", "https://cdn2.suno.ai/note.txt", new Uint8Array()), "");

assert.strictEqual(normalizeLyrics(""), "");
assert.strictEqual(normalizeLyrics("   \n  "), "");
assert.strictEqual(normalizeLyrics("Instrumental"), "");
assert.strictEqual(normalizeLyrics("No lyrics available"), "");
assert.strictEqual(normalizeLyrics("This song is instrumental"), "");
assert.strictEqual(normalizeLyrics("Lyrics\n[Verse]\nLine one"), "[Verse]\nLine one");
assert.strictEqual(normalizeLyrics("[Verse]\nLine one\n\n\nLine two\n"), "[Verse]\nLine one\n\nLine two");

assert.strictEqual(lyricsPresence(""), "empty");
assert.strictEqual(lyricsPresence("Lyrics"), "empty");
assert.strictEqual(lyricsPresence("No lyrics available"), "absent");
assert.strictEqual(lyricsPresence("Lyrics\nInstrumental"), "absent");
assert.strictEqual(lyricsPresence("[Verse]\nLine one"), "lyrics");

assert.strictEqual(composeSidecarText("", ""), "");
assert.strictEqual(composeSidecarText("   ", "  "), "");
assert.strictEqual(composeSidecarText("Soft piano, slow pulse", ""), "Soft piano, slow pulse");
assert.strictEqual(composeSidecarText("", "[Verse]\nLine one"), "[Verse]\nLine one");
assert.strictEqual(
  composeSidecarText("Soft piano, slow pulse", "[Verse]\nLine one"),
  "Soft piano, slow pulse\n\n[Verse]\nLine one"
);

const saved = [
  { filename: "C:/Users/kevin/Downloads/Suno/Bubble Pop.txt", bytes: 80 },
  { filename: "C:/Users/kevin/Downloads/Suno/Bubble Pop.jpg", bytes: 1200 },
  { filename: "C:/Users/kevin/Downloads/Suno/Bubble Pop (1).jpg", bytes: 1200 },
  { filename: "C:/Users/kevin/Downloads/Suno/Cover Only.jpg", bytes: 900 },
  { filename: "C:/Users/kevin/Downloads/Suno/Empty.txt", bytes: 0 },
  { filename: "C:/Users/kevin/Downloads/Suno/Lyrics Only.txt", bytes: 40 },
];
assert.deepStrictEqual(planSidecarSave(saved, "Suno/Bubble Pop"), {
  hasLyrics: true,
  hasCover: true,
  skipSong: true,
  saveLyrics: false,
  saveCover: false,
});
assert.deepStrictEqual(planSidecarSave(saved, "Suno/Cover Only"), {
  hasLyrics: false,
  hasCover: true,
  skipSong: false,
  saveLyrics: true,
  saveCover: false,
});
assert.deepStrictEqual(planSidecarSave(saved, "Suno/Empty"), {
  hasLyrics: false,
  hasCover: false,
  skipSong: false,
  saveLyrics: true,
  saveCover: true,
});
assert.deepStrictEqual(planSidecarSave(saved, "Suno/Lyrics Only"), {
  hasLyrics: true,
  hasCover: false,
  skipSong: false,
  saveLyrics: false,
  saveCover: true,
});
assert.strictEqual(
  planSidecarSave(
    [{ filename: "C:/Users/kevin/Downloads/Suno/Bubble Pop (1).jpg", bytes: 1200 }],
    "Suno/Bubble Pop"
  ).hasCover,
  false
);

console.log("sidecar_utils ok");
