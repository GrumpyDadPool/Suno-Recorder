const assert = require("assert");
const { isSunoCoverUrl, coverAltTitle, imageExtension, normalizeLyrics } = require("./sidecar_utils.js");

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
assert.strictEqual(normalizeLyrics("[Verse]\nLine one\n\n\nLine two\n"), "[Verse]\nLine one\n\nLine two");

console.log("sidecar_utils ok");
