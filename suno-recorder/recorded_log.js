// Recorded-song ledger. Library capture skips titles in this list. A title
// removed in Options stays off the list until that song is recorded again or
// an explicit folder scan includes it. Names that share a titleKey, or the
// same titleKey ignoring case, are one row.

const RECORDED_TITLES_KEY = "sunoCaptureRecordedTitles";
const DISMISSED_TITLE_KEYS_KEY = "sunoCaptureDismissedTitleKeys";

// Content scripts load title_utils.js first, so titleKey is already global.
// Node tests load this file on its own.
const recordedTitleKey =
  typeof titleKey === "function" ? titleKey : require("./title_utils.js").titleKey;

function titleFromCapturedName(name, prefix) {
  let base = String(name || "").replace(/\\/g, "/");
  const slash = base.lastIndexOf("/");
  if (slash >= 0) base = base.slice(slash + 1);
  base = base.replace(/\.(wav|webm|ogg|mp3|m4a)$/i, "");
  if (prefix && base.startsWith(prefix)) base = base.slice(prefix.length);
  return base.trim();
}

function normalizeRecordedEntry(entry) {
  if (!entry) return null;
  const title = String(typeof entry === "string" ? entry : entry.title || "").trim();
  const key = recordedTitleKey(title);
  if (!title || !key) return null;
  const recordedAt = typeof entry === "object" && entry ? Number(entry.recordedAt) || 0 : 0;
  return { title, key, recordedAt };
}

function recordedFold(key) {
  return String(key || "").toLowerCase();
}

function mergeRecordedTitles(existing, incomingTitles, dismissedKeys) {
  const dismissed = new Set((dismissedKeys || []).filter(Boolean).map(recordedFold));
  const byKey = new Map();
  for (const entry of existing || []) {
    const normalized = normalizeRecordedEntry(entry);
    const fold = normalized && recordedFold(normalized.key);
    if (!normalized || dismissed.has(fold) || byKey.has(fold)) continue;
    byKey.set(fold, normalized);
  }
  const added = [];
  for (const raw of incomingTitles || []) {
    const normalized = normalizeRecordedEntry(raw);
    const fold = normalized && recordedFold(normalized.key);
    if (!normalized || dismissed.has(fold)) continue;
    const previous = byKey.get(fold);
    if (previous) {
      if (normalized.recordedAt > previous.recordedAt) {
        byKey.set(fold, {
          title: normalized.title,
          key: normalized.key,
          recordedAt: normalized.recordedAt,
        });
      }
      continue;
    }
    byKey.set(fold, normalized);
    added.push(normalized);
  }
  return { titles: Array.from(byKey.values()), added };
}

function dismissRecordedTitle(existing, dismissedKeys, title) {
  const key = recordedTitleKey(String(title || "").trim());
  const fold = recordedFold(key);
  const titles = [];
  for (const entry of existing || []) {
    const normalized = normalizeRecordedEntry(entry);
    if (!normalized || (key && recordedFold(normalized.key) === fold)) continue;
    titles.push(normalized);
  }
  const dismissed = Array.from(new Set([...(dismissedKeys || []).filter(Boolean), key].filter(Boolean)));
  return { titles, dismissed };
}

function storageLocalGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result || {});
    });
  });
}

function storageLocalSet(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

async function loadRecordedState() {
  const stored = await storageLocalGet([RECORDED_TITLES_KEY, DISMISSED_TITLE_KEYS_KEY]);
  return {
    titles: Array.isArray(stored[RECORDED_TITLES_KEY]) ? stored[RECORDED_TITLES_KEY] : [],
    dismissed: Array.isArray(stored[DISMISSED_TITLE_KEYS_KEY]) ? stored[DISMISSED_TITLE_KEYS_KEY] : [],
  };
}

async function mergeIncomingRecordedTitles(incomingTitles, options) {
  const overrideDismissed = Boolean(options && options.overrideDismissed);
  const state = await loadRecordedState();
  let dismissed = state.dismissed.slice();
  if (overrideDismissed) {
    const incomingKeys = new Set(
      (incomingTitles || [])
        .map((entry) => recordedFold(recordedTitleKey(typeof entry === "string" ? entry : entry && entry.title)))
        .filter(Boolean)
    );
    dismissed = dismissed.filter((key) => !incomingKeys.has(recordedFold(key)));
  }
  const merged = mergeRecordedTitles(state.titles, incomingTitles, dismissed);
  await storageLocalSet({
    [RECORDED_TITLES_KEY]: merged.titles,
    [DISMISSED_TITLE_KEYS_KEY]: dismissed,
  });
  return merged;
}

async function rememberRecordedTitle(title) {
  return mergeIncomingRecordedTitles([{ title, recordedAt: Date.now() }], { overrideDismissed: true });
}

async function forgetRecordedTitle(title) {
  const state = await loadRecordedState();
  const next = dismissRecordedTitle(state.titles, state.dismissed, title);
  await storageLocalSet({
    [RECORDED_TITLES_KEY]: next.titles,
    [DISMISSED_TITLE_KEYS_KEY]: next.dismissed,
  });
  return next;
}

async function clearRecordedTitles() {
  const state = await loadRecordedState();
  const keys = state.titles.map((entry) => normalizeRecordedEntry(entry)).filter(Boolean).map((entry) => entry.key);
  const dismissed = Array.from(new Set([...state.dismissed.filter(Boolean), ...keys]));
  await storageLocalSet({
    [RECORDED_TITLES_KEY]: [],
    [DISMISSED_TITLE_KEYS_KEY]: dismissed,
  });
}

if (typeof module !== "undefined") {
  module.exports = {
    RECORDED_TITLES_KEY,
    DISMISSED_TITLE_KEYS_KEY,
    titleFromCapturedName,
    normalizeRecordedEntry,
    mergeRecordedTitles,
    dismissRecordedTitle,
  };
}
