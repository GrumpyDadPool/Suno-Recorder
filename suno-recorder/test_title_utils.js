// Tiny Node checks for title sanitizer + save-folder / download-path helpers.
const assert = require("assert");
const {
  sanitizeTitle,
  sanitizeFolder,
  buildRelativePath,
  titleKey,
  selectTargetTitle,
  playbarIdentityChanged,
} = require("./title_utils.js");

// Stand-in title. Nothing here is a real library track.
const SAMPLE_TRACK = "Sample Track";

assert.strictEqual(sanitizeTitle(`Play "${SAMPLE_TRACK}"`.match(/^Play "(.*)"$/s)[1]), SAMPLE_TRACK);
assert.strictEqual(sanitizeTitle("Hello / World??"), "Hello - World？？");
assert.strictEqual(sanitizeTitle("@@@"), "@@@");
assert.strictEqual(sanitizeTitle(""), "untitled");
assert.strictEqual(sanitizeTitle("Track_Name-1"), "Track_Name-1");
assert.strictEqual(sanitizeTitle("Song #1"), "Song #1");
assert.strictEqual(sanitizeTitle("Track *Star*"), "Track ＊Star＊");
assert.strictEqual(sanitizeTitle("Don't Stop"), "Don't Stop");
assert.strictEqual(sanitizeTitle("A & B (live)"), "A & B (live)");
assert.strictEqual(sanitizeTitle(".."), "untitled");

// sanitizeFolder: default fallback, plain names, nesting, and traversal safety.
assert.strictEqual(sanitizeFolder(""), "Suno Recorder");
assert.strictEqual(sanitizeFolder("   "), "Suno Recorder");
assert.strictEqual(sanitizeFolder("Suno Recorder"), "Suno Recorder");
assert.strictEqual(sanitizeFolder("My Songs/2024"), "My Songs/2024");
assert.strictEqual(sanitizeFolder("a\\b"), "a/b");
assert.strictEqual(sanitizeFolder("../../etc"), "etc"); // ".." segments stripped
assert.strictEqual(sanitizeFolder("./nested"), "nested");
assert.strictEqual(sanitizeFolder("bad:*?name"), "bad：＊？name");
assert.strictEqual(sanitizeFolder("@@@", "Fallback"), "@@@");
assert.strictEqual(sanitizeFolder("<>", "Fallback"), "Fallback");

// buildRelativePath: folder + prefix + sanitized title, no extension.
assert.strictEqual(buildRelativePath("Suno Recorder", "", SAMPLE_TRACK), `Suno Recorder/${SAMPLE_TRACK}`);
assert.strictEqual(buildRelativePath("Suno Recorder", "suno-", SAMPLE_TRACK), `Suno Recorder/suno-${SAMPLE_TRACK}`);
assert.strictEqual(buildRelativePath("", "", "Hello / World??"), "Suno Recorder/Hello - World？？");
assert.strictEqual(buildRelativePath("Suno Recorder", "", "Song #1"), "Suno Recorder/Song #1");
assert.strictEqual(buildRelativePath("Suno Recorder", "", "Track *Star*"), "Suno Recorder/Track ＊Star＊");
assert.strictEqual(buildRelativePath("Albums/EP", "", "Track_Name-1"), "Albums/EP/Track_Name-1");

// titleKey + one-song selection. Callers pass the title; nothing is hardcoded.
assert.strictEqual(titleKey(`  ${SAMPLE_TRACK}  `), SAMPLE_TRACK);
assert.strictEqual(titleKey("Sample “Track”"), "Sample 'Track'");
assert.deepStrictEqual(selectTargetTitle(["Alpha", SAMPLE_TRACK, "Beta"], ""), ["Alpha", SAMPLE_TRACK, "Beta"]);
assert.deepStrictEqual(selectTargetTitle(["Alpha", SAMPLE_TRACK, "Beta"], SAMPLE_TRACK), [SAMPLE_TRACK]);
assert.deepStrictEqual(selectTargetTitle(["Alpha", SAMPLE_TRACK], "sample track"), [SAMPLE_TRACK]);
assert.deepStrictEqual(selectTargetTitle(["Alpha", "Beta"], "Missing Song"), []);
assert.deepStrictEqual(selectTargetTitle(["Alpha", "Beta"], "   "), ["Alpha", "Beta"]);

const sameTrack = { title: SAMPLE_TRACK, id: "song-1" };
assert.strictEqual(playbarIdentityChanged(sameTrack, { title: SAMPLE_TRACK, id: "song-1" }), false);
assert.strictEqual(playbarIdentityChanged(sameTrack, { title: "Other Track", id: "song-2" }), true);
assert.strictEqual(playbarIdentityChanged(sameTrack, { title: "Other Track", id: "" }), true);
assert.strictEqual(playbarIdentityChanged(sameTrack, { title: "", id: "" }), true);
assert.strictEqual(playbarIdentityChanged({ title: SAMPLE_TRACK, id: "" }, { title: `  ${SAMPLE_TRACK}  `, id: "" }), false);

console.log("title_utils ok");
