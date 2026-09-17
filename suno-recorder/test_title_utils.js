// Tiny Node checks for title sanitizer + popup status rendering helpers.
const assert = require("assert");
const { sanitizeTitle } = require("./title_utils.js");

assert.strictEqual(sanitizeTitle('Play "Big Black Chalk"'.match(/^Play "(.*)"$/s)[1]), "Big Black Chalk");
assert.strictEqual(sanitizeTitle("Hello / World??"), "Hello  World");
assert.strictEqual(sanitizeTitle("@@@"), "untitled");
assert.strictEqual(sanitizeTitle(""), "untitled");
assert.strictEqual(sanitizeTitle("Track_Name-1"), "Track_Name-1");

console.log("title_utils ok");
