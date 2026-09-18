// Tiny Node checks for title sanitizer + save-folder / download-path helpers.
const assert = require("assert");
const { sanitizeTitle, sanitizeFolder, buildRelativePath } = require("./title_utils.js");

assert.strictEqual(sanitizeTitle('Play "Big Black Chalk"'.match(/^Play "(.*)"$/s)[1]), "Big Black Chalk");
assert.strictEqual(sanitizeTitle("Hello / World??"), "Hello  World");
assert.strictEqual(sanitizeTitle("@@@"), "untitled");
assert.strictEqual(sanitizeTitle(""), "untitled");
assert.strictEqual(sanitizeTitle("Track_Name-1"), "Track_Name-1");

// sanitizeFolder: default fallback, plain names, nesting, and traversal safety.
assert.strictEqual(sanitizeFolder(""), "Suno Recorder");
assert.strictEqual(sanitizeFolder("   "), "Suno Recorder");
assert.strictEqual(sanitizeFolder("Suno Recorder"), "Suno Recorder");
assert.strictEqual(sanitizeFolder("My Songs/2024"), "My Songs/2024");
assert.strictEqual(sanitizeFolder("a\\b"), "a/b");
assert.strictEqual(sanitizeFolder("../../etc"), "etc"); // ".." segments stripped
assert.strictEqual(sanitizeFolder("./nested"), "nested");
assert.strictEqual(sanitizeFolder("bad:*?name"), "badname");
assert.strictEqual(sanitizeFolder("@@@", "Fallback"), "Fallback");

// buildRelativePath: folder + prefix + sanitized title, no extension.
assert.strictEqual(buildRelativePath("Suno Recorder", "", "Big Black Chalk"), "Suno Recorder/Big Black Chalk");
assert.strictEqual(buildRelativePath("Suno Recorder", "suno-", "Big Black Chalk"), "Suno Recorder/suno-Big Black Chalk");
assert.strictEqual(buildRelativePath("", "", "Hello / World??"), "Suno Recorder/Hello  World");
assert.strictEqual(buildRelativePath("Albums/EP", "", "Track_Name-1"), "Albums/EP/Track_Name-1");

console.log("title_utils ok");
