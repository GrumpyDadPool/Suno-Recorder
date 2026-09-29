const assert = require("assert");
const { titleKey } = require("./title_utils.js");
const { mergeRecordedTitles, dismissRecordedTitle, titleFromCapturedName } = require("./recorded_log.js");

const alpha = { title: "Alpha", key: titleKey("Alpha"), recordedAt: 1 };
const beta = { title: "Beta", key: titleKey("Beta"), recordedAt: 2 };

const first = mergeRecordedTitles([], ["Alpha"], []);
assert.strictEqual(first.added.length, 1);
assert.strictEqual(first.titles[0].title, "Alpha");

const again = mergeRecordedTitles(first.titles, ["Alpha"], []);
assert.strictEqual(again.added.length, 0);
assert.strictEqual(again.titles.length, 1);

const blocked = mergeRecordedTitles([], ["Alpha", "Beta"], [titleKey("Alpha")]);
assert.deepStrictEqual(blocked.added.map((entry) => entry.title), ["Beta"]);

const refreshed = mergeRecordedTitles([alpha], [{ title: "Alpha", recordedAt: 9 }], []);
assert.strictEqual(refreshed.titles[0].recordedAt, 9);
assert.strictEqual(refreshed.added.length, 0);

const removed = dismissRecordedTitle([alpha, beta], [], "Alpha");
assert.deepStrictEqual(removed.titles.map((entry) => entry.title), ["Beta"]);
assert.deepStrictEqual(removed.dismissed, [titleKey("Alpha")]);

const stayedGone = mergeRecordedTitles(removed.titles, ["Alpha"], removed.dismissed);
assert.deepStrictEqual(stayedGone.titles.map((entry) => entry.title), ["Beta"]);

const folded = mergeRecordedTitles([], ["Alpha", "alpha"], []);
assert.strictEqual(folded.titles.length, 1);
assert.strictEqual(folded.added.length, 1);
assert.strictEqual(folded.titles[0].title, "Alpha");

const foldedAgain = mergeRecordedTitles(folded.titles, ["alpha"], []);
assert.strictEqual(foldedAgain.added.length, 0);
assert.strictEqual(foldedAgain.titles.length, 1);
assert.strictEqual(foldedAgain.titles[0].title, "Alpha");

const foldedBlocked = mergeRecordedTitles([], ["alpha"], [titleKey("Alpha")]);
assert.strictEqual(foldedBlocked.added.length, 0);
assert.strictEqual(foldedBlocked.titles.length, 0);

const caseRefresh = mergeRecordedTitles([alpha], [{ title: "alpha", recordedAt: 5 }], []);
assert.strictEqual(caseRefresh.titles.length, 1);
assert.strictEqual(caseRefresh.titles[0].title, "alpha");
assert.strictEqual(caseRefresh.added.length, 0);

const removedFold = dismissRecordedTitle([alpha, { title: "alpha", key: titleKey("alpha"), recordedAt: 3 }], [], "Alpha");
assert.deepStrictEqual(removedFold.titles, []);
assert.deepStrictEqual(removedFold.dismissed, [titleKey("Alpha")]);

assert.strictEqual(titleFromCapturedName("Suno Recorder/suno-Alpha.wav", "suno-"), "Alpha");
assert.strictEqual(titleFromCapturedName("Beta.mp3", ""), "Beta");

console.log("recorded_log ok");
