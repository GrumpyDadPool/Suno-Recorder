// Runs on suno.com/me. Stays on this page for the whole capture session.
//
// Suno's library list is virtualized: only ~20–30 row play buttons exist in
// the DOM at once. Scrolling replaces rows rather than appending, so a raw
// button COUNT never grows past one viewport — that previously made discovery
// stop at ~24 tracks and then only "see" whatever was still mounted.
// Discovery therefore accumulates unique titles while scrolling.
//
// Row aria-label pattern: `Play "Track Name"` / `Pause "Track Name"`.

function runtimeAlive() {
  try {
    return Boolean(chrome.runtime && chrome.runtime.id);
  } catch (_) {
    return false;
  }
}

function isContextInvalidatedError(err) {
  const msg = String(err && err.message ? err.message : err);
  return /extension context invalidated/i.test(msg);
}

const RELOAD_HINT =
  "Extension was reloaded while this tab was open. Refresh suno.com/me, then click Start recording again.";

// Each inject bumps the generation so stale content scripts (from before Reload)
// ignore new storage events instead of crashing with "Extension context invalidated".
const SCRIPT_GENERATION = (globalThis.__sunoRecorderGeneration =
  (globalThis.__sunoRecorderGeneration || 0) + 1);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!runtimeAlive()) return false;
  if (message && message.target === "content" && message.type === "ping") {
    sendResponse({ ok: true, path: location.pathname, generation: SCRIPT_GENERATION });
    return false;
  }
  return false;
});

const ROW_LABEL_REGEX = /^(Play|Pause) "(.*)"$/s;
const MAX_SCROLL_ATTEMPTS = 200;
const MAX_TRACK_WAIT_MS = 10 * 60 * 1000;
const PLAYBACK_START_TIMEOUT_MS = 25_000;
const BUTTON_FIND_SCROLL_ATTEMPTS = 250;
// Give the (timeslice-free) MediaRecorder a moment to actually start pulling
// samples before we tell Suno to play, so the very start of each track isn't
// clipped ("cold open"). Spec: >=700ms warm-up.
const RECORDER_WARMUP_MS = 750;
// Lyrics often paint with the cover. If they are already on screen, save at once.
// Otherwise keep reading and give the panel 4 seconds of unchanged empty content
// before deciding there are no lyrics. Stop is the only cancel.
const LYRICS_POLL_MS = 400;
const LYRICS_ABSENT_STABLE_MS = 4000;
// After a row click, poll until the open song panel shows that title.
// Only this wait may fail the song; a miss must not advance the loop early.
const PANEL_OPEN_WAIT_MS = 4000;
const PANEL_OPEN_POLL_MS = 250;

let sessionRunning = false;
let startPending = false;
// Set true the moment a Stop is observed (the popup writes an "idle" state) so
// the running session can bail mid-track instead of only between tracks. The
// session keeps re-writing "capturing", so reading the stored status back is not
// a reliable way to notice a Stop — this flag is.
let stopRequested = false;
let heartbeatTimer = null;
// titleKey -> approx discovery scroll index (helps remount jumps)
const titleScrollIndex = new Map();
// Library scans only. One song must not send these keys or attach the debugger.
let libraryKeysBroken = false;
// Styles "Show more" stays expanded across songs. Click again only if a later
// song is collapsed and that control says Show more.
let stylesExpandedThisPass = false;

function touchHeartbeat() {
  try {
    if (!runtimeAlive()) return;
    chrome.storage.local.set({ sunoCaptureHeartbeat: Date.now() });
  } catch (_) {
    /* extension reloaded — ignore */
  }
}

function startSessionHeartbeat() {
  touchHeartbeat();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (SCRIPT_GENERATION !== globalThis.__sunoRecorderGeneration) {
      stopSessionHeartbeat();
      return;
    }
    touchHeartbeat();
  }, 15_000);
}

function stopSessionHeartbeat() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function assertAlive() {
  if (!runtimeAlive()) {
    throw new Error(RELOAD_HINT);
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getState() {
  return new Promise((resolve, reject) => {
    try {
      assertAlive();
      chrome.storage.local.get("sunoCaptureState", (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(result.sunoCaptureState || { status: "idle" });
      });
    } catch (err) {
      reject(err);
    }
  });
}

function setState(state) {
  return new Promise((resolve, reject) => {
    try {
      assertAlive();
      chrome.storage.local.set({ sunoCaptureState: state }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function getOptions() {
  assertAlive();
  const response = await chrome.runtime.sendMessage({ target: "background", type: "getOptions" });
  if (response && response.ok && response.options) return response.options;
  return {
    maxTracks: 0,
    filenamePrefix: "",
    skipCaptured: true,
    monitorAudio: true,
    saveFolder: "Suno Recorder",
  };
}

async function fetchSavedSidecars(saveFolder) {
  assertAlive();
  const response = await chrome.runtime.sendMessage({
    target: "background",
    type: "listSavedSidecars",
    saveFolder,
  });
  if (!response || !response.ok || !Array.isArray(response.files)) {
    throw new Error(response && response.error ? response.error : "could not list saved lyrics and covers");
  }
  return response.files;
}

function parseRowLabel(label) {
  const match = (label || "").match(ROW_LABEL_REGEX);
  if (!match) return null;
  return { action: match[1], title: match[2] };
}

// Skip keys come only from the recorded-song ledger. An explicit folder scan
// merges into that list once; later library runs do not re-read download
// history or the stored scan. Titles removed in Options are absent here, so
// they are not skipped until recorded or scanned again.
async function collectPreviouslyCapturedKeys(options, log) {
  let titles = [];
  try {
    const state = await loadRecordedState();
    titles = (state.titles || []).map((entry) => normalizeRecordedEntry(entry)).filter(Boolean);
  } catch (err) {
    log(`  ! could not read the recorded-song list: ${err && err.message ? err.message : err}`);
  }

  const keys = new Set(titles.map((entry) => entry.key).filter(Boolean));
  keys.delete("");
  if (keys.size) log(`${keys.size} title(s) already on the recorded-song list — those WAVs will not be downloaded.`);
  return keys;
}

function getRowButtons() {
  return Array.from(document.querySelectorAll("button[aria-label]")).filter((btn) =>
    parseRowLabel(btn.getAttribute("aria-label") || "")
  );
}

function extractTitle(button) {
  const parsed = parseRowLabel(button.getAttribute("aria-label") || "");
  return parsed ? parsed.title : "Untitled";
}

function findVisibleButtonByTitle(title) {
  const wanted = titleKey(title);
  return (
    getRowButtons().find((btn) => titleKey(extractTitle(btn)) === wanted) ||
    null
  );
}

function collectVisibleRows() {
  const seen = new Set();
  const rows = [];
  for (const button of getRowButtons()) {
    const title = extractTitle(button);
    const key = titleKey(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({ title, key, button });
  }
  return rows;
}

function getScrollParent(el) {
  let node = el && el.parentElement;
  while (node && node !== document.body) {
    const style = window.getComputedStyle(node);
    const overflowY = style.overflowY;
    if ((overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
        node.scrollHeight > node.clientHeight + 8) {
      return node;
    }
    node = node.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

function libraryScroller() {
  const buttons = getRowButtons();
  const anchor = buttons[0] || document.body;
  return getScrollParent(anchor);
}

function scrollLibraryDown() {
  const buttons = getRowButtons();
  const anchor = buttons[buttons.length - 1] || buttons[0];
  if (!anchor) {
    window.scrollBy(0, Math.floor(window.innerHeight * 0.85));
    return;
  }
  const scroller = getScrollParent(anchor);
  const before = scroller.scrollTop;
  const step = Math.max(120, Math.floor(scroller.clientHeight * 0.75));
  if (scroller && scroller !== document.body) {
    scroller.scrollTop = Math.min(scroller.scrollTop + step, scroller.scrollHeight);
  }
  // scrollIntoView on a row also scrolls every ancestor and desyncs Suno's
  // virtualized library, which clips page 1. Move only the list scroller.
  if (Math.abs(scroller.scrollTop - before) < 2) {
    window.scrollBy(0, Math.floor(window.innerHeight * 0.85));
  }
}

function scrollLibraryUp() {
  const scroller = libraryScroller();
  const before = scroller.scrollTop;
  const step = Math.max(120, Math.floor(scroller.clientHeight * 0.75));
  scroller.scrollTop = Math.max(0, scroller.scrollTop - step);
  if (Math.abs(scroller.scrollTop - before) < 2) {
    window.scrollBy(0, -Math.floor(window.innerHeight * 0.85));
  }
}

async function scrollLibraryToTop() {
  const scroller = libraryScroller();
  for (let i = 0; i < 20; i++) {
    if (scroller && scroller !== document.body && scroller !== document.documentElement) {
      scroller.scrollTop = 0;
    }
    window.scrollTo(0, 0);
    await sleep(80);
    if (!scroller || scroller.scrollTop <= 2) break;
  }
  await sleep(200);
}

// Same step, poll, and harvest as the downward scan. Three attempts that mount
// no new titles means that direction is exhausted (the top, when scrolling up).
async function scrollHarvesting(direction, discovered, harvest, log, until, move) {
  const STABLE_LIMIT = 3;
  let stableRounds = 0;
  let lastSize = discovered.size;
  const label = direction === "up" ? "up" : "down";
  const found = () => typeof until === "function" && until();

  for (let i = 0; i < MAX_SCROLL_ATTEMPTS; i++) {
    assertAlive();
    if (found()) {
      return { stopped: Boolean(stopRequested), found: true };
    }
    const state = await getState();
    if (stopRequested || !state || state.status === "idle") {
      log("Scan stopped.");
      return { stopped: true, found: false };
    }
    if (move) await move();
    else if (direction === "up") scrollLibraryUp();
    else scrollLibraryDown();
    const pollStart = Date.now();
    while (Date.now() - pollStart < 3500) {
      if (stopRequested) break;
      assertAlive();
      harvest(discovered, i + 1);
      if (found()) return { stopped: false, found: true };
      if (discovered.size > lastSize) break;
      await sleep(250);
    }
    harvest(discovered, i + 1);
    if (found()) return { stopped: false, found: true };
    if (discovered.size > lastSize) {
      log(`  scroll ${label} attempt ${i + 1}: ${discovered.size} unique titles so far (+${discovered.size - lastSize})`);
      lastSize = discovered.size;
      stableRounds = 0;
    } else {
      stableRounds += 1;
      log(`  scroll ${label} attempt ${i + 1}: ${discovered.size} unique titles (no new titles this attempt)`);
      if (stableRounds >= STABLE_LIMIT) {
        if (direction === "up") {
          log(`  no new tracks after ${STABLE_LIMIT} scroll(s) — top of the library reached.`);
        } else {
          log(`  no new tracks after ${STABLE_LIMIT} scroll(s) — bottom of the library reached.`);
        }
        return { stopped: false, found: false };
      }
    }
  }
  return { stopped: false, found: false };
}

const LIBRARY_NAV_KEYS = new Set(["Home", "End", "PageUp", "PageDown"]);

function isRowPlayButton(el) {
  if (!el || el.tagName !== "BUTTON") return false;
  return Boolean(parseRowLabel((el.getAttribute && el.getAttribute("aria-label")) || ""));
}

// Home / Page Up / Page Down scroll the list. They must not focus or activate a
// row Play button — that starts a song, and a second activation stops it.
function blurRowPlaybackFocus() {
  const active = document.activeElement;
  if (!active || active === document.body || typeof active.blur !== "function") return;
  if (isRowPlayButton(active) || insidePlayControl(active)) active.blur();
}

function canScrollElement(el) {
  if (!el || el === document.body || el === document.documentElement || el === document.scrollingElement) return false;
  return el.scrollHeight > el.clientHeight + 8;
}

function overflowScrolls(el) {
  if (!canScrollElement(el)) return false;
  try {
    const style = getComputedStyle(el);
    return /auto|scroll|overlay/.test(`${style.overflowY} ${style.overflow}`);
  } catch (_) {
    return false;
  }
}

// Smallest ancestor that holds the library rows. A page wrapper that also holds
// the open song panel is larger, and focusing that wrapper leaves Page Down on the panel.
function tightLibraryList() {
  let best = null;
  let bestArea = Infinity;
  for (const btn of getRowButtons()) {
    if (!isShown(btn)) continue;
    let node = btn.parentElement;
    for (let depth = 0; depth < 16 && node && node !== document.body && node !== document.documentElement; depth += 1) {
      if (elementContainsLibraryList(node)) {
        const rect = node.getBoundingClientRect();
        const area = Math.max(0, rect.width) * Math.max(0, rect.height);
        if (area > 0 && area < bestArea) {
          bestArea = area;
          best = node;
        }
        break;
      }
      node = node.parentElement;
    }
  }
  return best;
}

// The library scroll parent: the element whose scrollTop moves when Page Down hits the list.
function libraryListScroller() {
  const list = tightLibraryList();
  if (!list) return libraryScrollRoot();
  if (overflowScrolls(list)) return list;
  const inner = Array.from(list.querySelectorAll("div")).find(
    (el) => overflowScrolls(el) && elementContainsLibraryList(el)
  );
  if (inner) return inner;
  let node = list.parentElement;
  for (let depth = 0; depth < 6 && node && node !== document.body && node !== document.documentElement; depth += 1) {
    if (overflowScrolls(node)) return node;
    node = node.parentElement;
  }
  const chain = [list];
  node = list.parentElement;
  for (let depth = 0; depth < 6 && node && node !== document.body && node !== document.documentElement; depth += 1) {
    chain.push(node);
    node = node.parentElement;
  }
  let roomiest = null;
  let room = 0;
  for (const el of chain) {
    const extra = el.scrollHeight - el.clientHeight;
    if (extra > room) {
      room = extra;
      roomiest = el;
    }
  }
  return roomiest || libraryScrollRoot() || list;
}

// Blur is not enough once a song panel is open: Page Down follows focus.
// Focus the library scroll parent itself. One song never calls this.
function focusLibraryScroller() {
  const scroller = libraryListScroller();
  if (!scroller) return null;
  const blurAway = () => {
    const active = document.activeElement;
    if (!active || active === scroller || typeof active.blur !== "function") return;
    active.blur();
  };
  blurAway();
  blurRowPlaybackFocus();
  if (scroller !== document.body && scroller !== document.documentElement && scroller.tabIndex < 0) {
    scroller.tabIndex = -1;
  }
  if (typeof scroller.focus === "function") {
    try {
      scroller.focus({ preventScroll: true });
    } catch (_) {
      /* A focus without preventScroll scrolls the virtualized list and clips page 1. */
    }
  }
  if (document.activeElement !== scroller) {
    blurAway();
    blurRowPlaybackFocus();
    try {
      scroller.focus({ preventScroll: true });
    } catch (_) {
      /* ignore */
    }
  }
  return scroller;
}

// Block Home/Page keys only when they would hit a row Play button. This listener
// runs on window during capture; stopping the event while the library scroller
// is focused swallows Home/Page Up/Page Down before Suno can scroll.
function holdNavigationKeys(scroller) {
  const block = (event) => {
    if (!LIBRARY_NAV_KEYS.has(event.key)) return;
    const target = event.target;
    const onRowPlay =
      target &&
      target !== scroller &&
      (isRowPlayButton(target) || insidePlayControl(target) || (target.closest && target.closest("button") && isRowPlayButton(target.closest("button"))));
    if (!onRowPlay) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  window.addEventListener("keydown", block, true);
  return () => window.removeEventListener("keydown", block, true);
}

function visibleLibrarySignature() {
  return collectVisibleRows()
    .map((row) => row.key)
    .sort()
    .join("\n");
}

async function pressLibraryKey(name, log) {
  if (libraryKeysBroken) return false;
  const release = holdNavigationKeys(focusLibraryScroller());
  try {
    focusLibraryScroller();
    const response = await chrome.runtime.sendMessage({
      target: "background",
      type: "dispatchLibraryKey",
      key: name,
    });
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "debugger key failed");
    }
    return true;
  } catch (err) {
    libraryKeysBroken = true;
    log(`  debugger attach failed (${err && err.message ? err.message : err}); falling back to element scroll.`);
    return false;
  } finally {
    release();
  }
}

// Trusted Home, not scrollTop. scrollTop stays near 0 on Suno's virtualized list
// even when the first song is off screen, so it cannot mean "at the top".
async function homeLibraryToTop(log) {
  const CAP = 4;
  for (let i = 0; i < CAP; i++) {
    if (stopRequested) return false;
    focusLibraryScroller();
    const before = visibleLibrarySignature();
    const ok = await pressLibraryKey("Home", log);
    if (!ok) return false;
    await sleep(400);
    const after = visibleLibrarySignature();
    if (i > 0 && before === after) return true;
  }
  return !libraryKeysBroken;
}

// Home until the visible rows stop changing (cap 4). If that does not move the
// list, Page Up until three passes add no titles.
async function returnLibraryToTop(log) {
  log("Pressing Home to reach the top of the library.");
  const before = visibleLibrarySignature();
  const trusted = await homeLibraryToTop(log);
  if (stopRequested || !trusted) return false;
  if (before !== visibleLibrarySignature()) return true;
  log("Home did not move the library. Pressing Page Up until three attempts add nothing.");
  const seen = new Map();
  const harvest = (map) => {
    for (const row of collectVisibleRows()) {
      if (row.key && !map.has(row.key)) map.set(row.key, row.title);
    }
  };
  harvest(seen, 0);
  await scrollHarvesting("up", seen, harvest, log, null, async () => {
    const ok = await pressLibraryKey("PageUp", log);
    if (!ok) elementScrollStep("up");
  });
  return !stopRequested;
}

function elementScrollStep(direction) {
  if (direction === "up") scrollLibraryUp();
  else scrollLibraryDown();
}

async function scanLibraryFromTop(log, harvest) {
  libraryKeysBroken = false;
  log("Pressing Home to reach the top of the library.");
  const trusted = await homeLibraryToTop(log);
  if (stopRequested) return { stopped: true, discovered: new Map(), upward: new Map() };
  await selectFirstLibrarySong(log);
  if (stopRequested) return { stopped: true, discovered: new Map(), upward: new Map() };

  const upward = new Map();
  harvest(upward, 0);
  if (!trusted) {
    log("Debugger could not send keys. Falling back to element scroll steps.");
  } else {
    log("Pressing Page Up until three attempts add nothing, then Page Down.");
  }

  const keyStep = (direction) => async () => {
    if (libraryKeysBroken) {
      elementScrollStep(direction);
      return;
    }
    const ok = await pressLibraryKey(direction === "up" ? "PageUp" : "PageDown", log);
    if (!ok) elementScrollStep(direction);
  };

  log(`${trusted ? "Starting Page Up" : "Starting scroll up"} — ${upward.size} tracks visible.`);
  const up = await scrollHarvesting("up", upward, harvest, log, null, trusted ? keyStep("up") : null);
  if (up.stopped || stopRequested) return { stopped: true, discovered: upward, upward };

  const downTrusted = trusted && !libraryKeysBroken;
  log(
    downTrusted
      ? "Page Up settled. Scanning down with Page Down."
      : "Reached the top. Scanning down through the library."
  );
  const discovered = new Map();
  harvest(discovered, 0);
  log(`${downTrusted ? "Starting Page Down" : "Starting scroll down"} — ${discovered.size} tracks visible.`);
  await scrollHarvesting("down", discovered, harvest, log, null, downTrusted ? keyStep("down") : null);
  return { stopped: Boolean(stopRequested), discovered, upward };
}

function harvestVisibleTitles(intoMap, scrollIndex) {
  let added = 0;
  for (const row of collectVisibleRows()) {
    if (!intoMap.has(row.key)) {
      intoMap.set(row.key, row.title);
      titleScrollIndex.set(row.key, scrollIndex || 0);
      added++;
    }
  }
  return added;
}

async function discoverAllTitles(log) {
  titleScrollIndex.clear();
  const scan = await scanLibraryFromTop(log, (map, index) => harvestVisibleTitles(map, index));
  const discovered = scan.discovered;
  for (const [key, title] of scan.upward) {
    if (!discovered.has(key)) discovered.set(key, title);
  }
  const titles = Array.from(discovered.values());
  log(`Scrolled through the library, found ${titles.length} unique tracks.`);
  return titles;
}

function getMediaElements() {
  return Array.from(document.querySelectorAll("audio, video"));
}

function findPlayingMedia() {
  return getMediaElements().find((m) => !m.paused && !m.ended && m.currentTime > 0.05) || null;
}

function isPlaybarPlaying() {
  return Array.from(document.querySelectorAll("button[aria-label]")).some((btn) => {
    const label = (btn.getAttribute("aria-label") || "").toLowerCase();
    if (!label.includes("pause")) return false;
    // Prefer playbar controls; also accept a row that flipped to Pause.
    return label.includes("playbar") || /^pause\b/.test(label) || label.includes('pause "');
  });
}

function rowLooksPlaying(title) {
  const btn = findVisibleButtonByTitle(title);
  if (!btn) return false;
  const parsed = parseRowLabel(btn.getAttribute("aria-label") || "");
  return Boolean(parsed && parsed.action === "Pause");
}

// Find the control that is currently showing a "Pause" affordance — i.e. the
// thing Suno is actively playing. Prefer the playbar transport, then a generic
// "Pause" button, then a row that flipped to Pause.
function findActivePauseButton() {
  const buttons = Array.from(document.querySelectorAll("button[aria-label]"));
  const labelOf = (b) => (b.getAttribute("aria-label") || "").toLowerCase();
  return (
    buttons.find((b) => labelOf(b).includes("pause") && labelOf(b).includes("playbar")) ||
    buttons.find((b) => /^pause\b/.test(labelOf(b))) ||
    buttons.find((b) => labelOf(b).includes('pause "')) ||
    null
  );
}

// Stop all audio immediately. Suno auto-advances the playbar to the next track
// the instant the current one ends (even with library autoplay off). If we let
// that keep playing while we run the heavy WAV convert + download, its audio
// bleeds into the capture and the encode/download work causes an audible
// ~0.1-0.8s hitch. So the moment we detect a track boundary we pause the media
// elements (most immediate) AND click the transport's Pause so Suno's own state
// agrees and it won't silently resume.
function pauseAllPlayback(log) {
  let acted = false;

  for (const media of getMediaElements()) {
    if (!media.paused) {
      try {
        media.pause();
        acted = true;
      } catch (_) {
        /* ignore */
      }
    }
  }

  const pauseBtn = findActivePauseButton();
  if (pauseBtn) {
    forceClick(pauseBtn);
    acted = true;
  }

  if (log) log(acted ? "  paused playback before encode/download" : "  nothing playing to pause");
  return acted;
}

function hoverRow(button) {
  const row =
    button.closest('[role="row"], [role="listitem"], li, tr, [data-testid]') ||
    button.parentElement;
  const targets = [row, button].filter(Boolean);
  for (const el of targets) {
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent("pointerover", opts));
    el.dispatchEvent(new MouseEvent("mouseover", opts));
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, cancelable: true, view: window }));
  }
}

function forceClick(el) {
  if (!el) return;
  const opts = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 };
  try {
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  } catch (_) {
    /* ignore */
  }
  hoverRow(el);
  if (typeof el.focus === "function") {
    try {
      el.focus({ preventScroll: true });
    } catch (_) {
      el.focus();
    }
  }
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, opts));
  }
  // Native click as a final fallback for listeners that only bind via onclick.
  el.click();
}

async function clickPlayForTitle(title, button, log) {
  const strategies = [
    () => {
      log("  click: play control");
      forceClick(button);
    },
    () => {
      const row = button.closest('[role="row"], [role="listitem"], li, tr') || button.parentElement;
      log("  click: row container");
      if (row) forceClick(row);
      forceClick(findVisibleButtonByTitle(title) || button);
    },
    () => {
      log("  click: replay after brief pause");
      const current = findVisibleButtonByTitle(title) || button;
      const parsed = parseRowLabel(current.getAttribute("aria-label") || "");
      if (parsed && parsed.action === "Pause") {
        forceClick(current);
      }
    },
  ];

  for (let attempt = 0; attempt < strategies.length; attempt++) {
    if (stopRequested) return false;
    const currentBtn = findVisibleButtonByTitle(title) || button;
    const parsed = parseRowLabel(currentBtn.getAttribute("aria-label") || "");
    if (parsed && parsed.action === "Pause" && attempt === 0) {
      // Restart from the beginning.
      forceClick(currentBtn);
      await sleep(450);
    }
    strategies[attempt]();
    await sleep(500);

    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (stopRequested) return false;
      if (rowLooksPlaying(title) || isPlaybarPlaying() || findPlayingMedia()) {
        return true;
      }
      await sleep(200);
    }
    log(`  playback not confirmed after click attempt ${attempt + 1}`);
  }
  return false;
}

async function waitForPlaybackStart(timeoutMs, log) {
  const start = Date.now();
  let lastMediaCount = getMediaElements().length;
  while (Date.now() - start < timeoutMs) {
    if (stopRequested) return { ok: false, media: null, via: null };
    const playing = findPlayingMedia();
    if (playing) return { ok: true, media: playing, via: "media-element" };
    if (isPlaybarPlaying()) return { ok: true, media: findPlayingMedia(), via: "playbar" };

    const mediaCount = getMediaElements().length;
    if (mediaCount !== lastMediaCount) {
      lastMediaCount = mediaCount;
      log(`  media elements now: ${mediaCount}`);
    }
    await sleep(200);
  }
  return { ok: false, media: null, via: null };
}

async function waitForTrackEnd(media, log) {
  const startedAt = Date.now();
  let sawPlayback = Boolean(media && !media.paused && media.currentTime > 0.05) || isPlaybarPlaying();
  let lastTime = media ? media.currentTime : 0;
  let stuckMs = 0;

  while (Date.now() - startedAt < MAX_TRACK_WAIT_MS) {
    if (stopRequested) {
      log("  stop requested — ending capture of this track");
      return;
    }
    const current = findPlayingMedia() || media;
    if (current && !current.paused && current.currentTime > 0.05) {
      sawPlayback = true;
      if (current.ended) {
        log("  track ended (media ended event state)");
        return;
      }
      if (current.currentTime + 0.01 < lastTime) {
        // Seeked backwards / new track took over the same element.
        log("  playback position jumped backward — treating as track boundary");
        return;
      }
      if (Math.abs(current.currentTime - lastTime) < 0.01) {
        stuckMs += 300;
      } else {
        stuckMs = 0;
        lastTime = current.currentTime;
      }
      // Near the end, some players pause instead of firing ended.
      if (current.duration && Number.isFinite(current.duration) && current.currentTime >= current.duration - 0.35) {
        log("  reached media duration");
        return;
      }
      if (stuckMs >= 8000 && current.currentTime > 1) {
        log("  playback stalled after progress — stopping capture for this track");
        return;
      }
    } else if (sawPlayback) {
      // Was playing, now neither media nor playbar says playing.
      if (!isPlaybarPlaying()) {
        await sleep(400);
        if (!findPlayingMedia() && !isPlaybarPlaying()) {
          log("  playback stopped");
          return;
        }
      }
    } else if (isPlaybarPlaying()) {
      sawPlayback = true;
    }

    await sleep(300);
  }
  log("  hit per-track time cap");
}

async function findButtonByTitle(title, log) {
  const wanted = titleKey(title);
  let hit = findVisibleButtonByTitle(title);
  if (hit) return hit;

  // After a full-library scan the DOM usually only has the *bottom* viewport.
  // Remounting a earlier row means scrolling the virtualized list until it returns.
  log(`  looking for "${title}" in the list (row not on screen — normal for long libraries)`);

  const approx = titleScrollIndex.get(wanted);
  const scroller = libraryScroller();
  if (typeof approx === "number" && approx > 0 && scroller.scrollHeight > scroller.clientHeight) {
    // Jump near where we first saw it during discovery, then hunt locally.
    const ratio = Math.min(1, approx / Math.max(1, MAX_SCROLL_ATTEMPTS));
    scroller.scrollTop = Math.floor(scroller.scrollHeight * ratio * 0.9);
    await sleep(350);
    hit = findVisibleButtonByTitle(title);
    if (hit) return hit;
  }

  const seen = new Map();
  const harvestRows = (map) => {
    for (const row of collectVisibleRows()) {
      if (row.key && !map.has(row.key)) map.set(row.key, row.title);
    }
  };
  harvestRows(seen);
  const up = await scrollHarvesting("up", seen, harvestRows, log, () => Boolean(findVisibleButtonByTitle(title)));
  hit = findVisibleButtonByTitle(title);
  if (hit || up.stopped || stopRequested) return hit;

  for (let i = 0; i < BUTTON_FIND_SCROLL_ATTEMPTS; i++) {
    if (stopRequested) return null;
    scrollLibraryDown();
    await sleep(220);
    hit = findVisibleButtonByTitle(title);
    if (hit) {
      log(`  found "${title}" after ${i + 1} scroll(s)`);
      return hit;
    }
    if ((i + 1) % 25 === 0) {
      log(`  still searching for "${title}"… (${i + 1}/${BUTTON_FIND_SCROLL_ATTEMPTS})`);
    }
  }

  // One more pass upward from the bottom in case we overshot.
  log(`  not found scrolling down — searching upward for "${title}"`);
  for (let i = 0; i < BUTTON_FIND_SCROLL_ATTEMPTS; i++) {
    if (stopRequested) return null;
    scrollLibraryUp();
    await sleep(220);
    hit = findVisibleButtonByTitle(title);
    if (hit) {
      log(`  found "${title}" scrolling up`);
      return hit;
    }
  }

  return null;
}

function cleanPlaybarTitle(text) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > 180) return "";
  if (/^playbar\b/i.test(cleaned)) return "";
  if (/^\d+:\d{2}$/.test(cleaned)) return "";
  return cleaned;
}

function titleFromPlaybarLabel(label) {
  const raw = String(label || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const stripped = raw.replace(/^playbar:\s*title\s*(for\s+)?/i, "").trim();
  return cleanPlaybarTitle(stripped);
}

function songIdFromHref(href) {
  const match = String(href || "").match(/\/song\/([^/?#]+)/);
  return match ? match[1] : "";
}

function hrefOf(el) {
  if (!el) return "";
  if (typeof el.getAttribute === "function") {
    const own = el.getAttribute("href");
    if (own) return own;
  }
  const nested = typeof el.querySelector === "function" ? el.querySelector('a[href*="/song/"]') : null;
  if (nested) return nested.getAttribute("href") || "";
  const ancestor = typeof el.closest === "function" ? el.closest('a[href*="/song/"]') : null;
  if (ancestor) return ancestor.getAttribute("href") || "";
  return "";
}

function isShown(el) {
  if (!el || typeof el.getBoundingClientRect !== "function") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1 && rect.bottom > 0 && rect.top < window.innerHeight;
}

function visibleTitleOf(el) {
  if (!el) return "";
  const direct = Array.from(el.childNodes || [])
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => String(node.textContent || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");
  const directTitle = cleanPlaybarTitle(direct);
  if (directTitle) return directTitle;
  for (const child of el.children || []) {
    if (child.tagName === "BUTTON") continue;
    const childTitle = cleanPlaybarTitle((child.textContent || "").replace(/\s+/g, " ").trim());
    if (childTitle) return childTitle;
  }
  return cleanPlaybarTitle((el.textContent || "").replace(/\s+/g, " ").trim());
}

function trackFromPlaybarNode(el) {
  if (!el) return { title: "", id: "" };
  const labelTitle = titleFromPlaybarLabel(el.getAttribute ? el.getAttribute("aria-label") : "");
  const title = labelTitle || visibleTitleOf(el);
  return { title, id: songIdFromHref(hrefOf(el)) };
}

function trackAroundPlaybarNode(el) {
  const own = trackFromPlaybarNode(el);
  if (own.title || !el.parentElement) return own;
  for (const child of el.parentElement.children) {
    if (child === el || child.tagName === "BUTTON") continue;
    const label = (child.getAttribute && child.getAttribute("aria-label")) || "";
    if (/playbar/i.test(label) && !/title/i.test(label)) continue;
    const title = visibleTitleOf(child);
    if (!title || /^(like|share|remix|edit|follow|more|queue|lyrics)$/i.test(title)) continue;
    return { title, id: own.id || songIdFromHref(hrefOf(child)) };
  }
  return own;
}

// A queued or paused song is still "on the bar": the control may not be an
// <a>, and aria-label may stay "Playbar: Title" while the name is textContent.
// An empty bar has the same chrome with no name — that is not a title.
function readPlaybarTrack() {
  const nodes = Array.from(
    document.querySelectorAll(
      '[aria-label*="Playbar: Title"], a[aria-label*="Playbar"][href*="/song/"]'
    )
  );
  // Prefer the on-screen play bar. A hidden empty shell earlier in the DOM
  // used to win querySelector and hide a queued song's textContent title.
  const shownNodes = nodes.filter(isShown);
  const pool = shownNodes.length ? shownNodes : nodes;
  const ranked = pool
    .map((el) => ({ el, track: trackAroundPlaybarNode(el), shown: isShown(el) }))
    .filter((entry) => entry.track.title);
  ranked.sort((a, b) => {
    if (a.shown !== b.shown) return a.shown ? -1 : 1;
    const aTop = a.el.getBoundingClientRect().top;
    const bTop = b.el.getBoundingClientRect().top;
    return bTop - aTop;
  });
  if (ranked.length) return ranked[0].track;

  const transport = findPlaybarTransportButton();
  let scope = transport ? transport.parentElement : null;
  for (let depth = 0; depth < 6 && scope; depth += 1) {
    const rect = scope.getBoundingClientRect();
    if (rect.height > 240) break;
    const link = Array.from(scope.querySelectorAll('a[href*="/song/"]')).find((el) => {
      const track = trackFromPlaybarNode(el);
      return Boolean(track.title) && isShown(el);
    });
    if (link) return trackFromPlaybarNode(link);
    scope = scope.parentElement;
  }

  return { title: "", id: "" };
}

const ONE_SONG_PROMPT = "Click the song so it shows on the bottom play bar.";

function buttonShowsPause(btn) {
  if (!btn) return false;
  const label = (btn.getAttribute("aria-label") || "").toLowerCase();
  if (label.includes("pause")) return true;
  if (/\bplay\b/.test(label)) return false;
  const rects = btn.querySelectorAll("svg rect");
  return rects.length >= 2;
}

// Bottom transport only. Row controls are `Play "Title"` / `Pause "Title"` and
// do not say Playbar. Skip, next, and the title link are not the play control.
function findPlaybarTransportButton() {
  const buttons = Array.from(document.querySelectorAll("button[aria-label]"));
  const matches = buttons.filter((btn) => {
    const label = (btn.getAttribute("aria-label") || "").toLowerCase();
    if (!label.includes("playbar")) return false;
    if (/\b(skip|next|previous|prev|title|shuffle|repeat|volume|queue|like|share)\b/.test(label)) return false;
    return /\b(play|pause)\b/.test(label);
  });
  const labelled =
    matches.find((btn) => (btn.getAttribute("aria-label") || "").toLowerCase().includes("pause")) ||
    matches[0];
  if (labelled) return labelled;

  // Queued / paused transport sometimes omits the word "Playbar" on the
  // play control itself. Stay inside the title's bar so a library row is not clicked.
  const titleNode = Array.from(document.querySelectorAll('[aria-label*="Playbar: Title"]')).find(isShown);
  let scope = titleNode ? titleNode.parentElement : null;
  for (let depth = 0; depth < 6 && scope; depth += 1) {
    const rect = scope.getBoundingClientRect();
    if (rect.height > 240) break;
    const local = Array.from(scope.querySelectorAll("button[aria-label]")).filter((btn) => {
      const label = (btn.getAttribute("aria-label") || "").toLowerCase();
      if (/\b(skip|next|previous|prev|shuffle|repeat|volume|queue|like|share|title)\b/.test(label)) return false;
      return /\b(play|pause)\b/.test(label);
    });
    if (local.length) {
      return (
        local.find((btn) => (btn.getAttribute("aria-label") || "").toLowerCase().includes("pause")) ||
        local[0]
      );
    }
    scope = scope.parentElement;
  }
  return null;
}

function rewindMediaToStart() {
  for (const media of getMediaElements()) {
    try {
      if (media.currentTime > 0.05) media.currentTime = 0;
    } catch (_) {
      /* ignore */
    }
  }
}

// Stop, or beginSession's pre-arm reset. A stale-session reset and a capture
// startup failure write idle too, and those must not cancel this wait.
function userEndedSession(state) {
  if (!state || state.status !== "idle") return false;
  if (state.stoppedAt) return true;
  if (state.resetAt && !state.resetReason && !state.failedAt) return true;
  return false;
}

let oneSongStartedAt = 0;

// No deadline. An empty play bar is not a failure. Tab-capture startup has
// its own timeout and must not be consulted here. Stop is the only cancel.
async function waitForPlaybarTitle(log) {
  log(ONE_SONG_PROMPT);
  const startedAt = Date.now();
  oneSongStartedAt = startedAt;
  await setState({
    status: "collecting",
    mode: "one",
    prompt: ONE_SONG_PROMPT,
    queue: [],
    currentIndex: 0,
    startedAt,
  });
  let ticks = 0;
  while (!stopRequested) {
    let state = null;
    try {
      state = await getState();
    } catch (_) {
      await sleep(300);
      continue;
    }
    if (!state || userEndedSession(state)) {
      stopRequested = true;
      break;
    }
    if (state.status === "starting" && state.startedAt && state.startedAt !== startedAt) {
      stopRequested = true;
      break;
    }
    if (state.status !== "collecting" && state.status !== "capturing") {
      try {
        await setState({
          status: "collecting",
          mode: "one",
          prompt: ONE_SONG_PROMPT,
          queue: [],
          currentIndex: 0,
          startedAt,
        });
      } catch (_) {
        /* keep waiting — Stop is the only cancel */
      }
    }
    let track = { title: "", id: "" };
    try {
      track = readPlaybarTrack();
    } catch (_) {
      track = { title: "", id: "" };
    }
    if (track.title) return track;
    ticks += 1;
    if (ticks % 10 === 0) touchHeartbeat();
    if (ticks % 50 === 0) log(ONE_SONG_PROMPT);
    await sleep(300);
  }
  return null;
}

async function supersededOneSong() {
  try {
    const state = await getState();
    if (!state || !state.startedAt || !oneSongStartedAt) return false;
    return state.startedAt !== oneSongStartedAt && state.status !== "idle";
  } catch (_) {
    return false;
  }
}

async function waitForPlaybarChange(initial, log) {
  const startedAt = Date.now();
  let sawPlayback = false;
  while (Date.now() - startedAt < MAX_TRACK_WAIT_MS) {
    if (stopRequested) {
      log("  stop requested — ending capture of this track");
      return;
    }
    const current = readPlaybarTrack();
    if (sawPlayback && playbarIdentityChanged(initial, current)) {
      log(`  play bar changed${current.title ? ` to "${current.title}"` : ""} — ending capture`);
      return;
    }
    const media = findPlayingMedia();
    if (media || isPlaybarPlaying()) {
      sawPlayback = true;
      if (media && media.ended) {
        log("  track ended");
        return;
      }
      if (
        media &&
        media.duration &&
        Number.isFinite(media.duration) &&
        media.currentTime >= media.duration - 0.35
      ) {
        log("  reached media duration");
        return;
      }
    } else if (sawPlayback) {
      await sleep(400);
      const after = readPlaybarTrack();
      if (playbarIdentityChanged(initial, after)) {
        log(`  play bar changed${after.title ? ` to "${after.title}"` : ""} — ending capture`);
        return;
      }
      if (!findPlayingMedia() && !isPlaybarPlaying()) {
        log("  playback stopped");
        return;
      }
    }
    await sleep(sawPlayback ? 100 : 200);
  }
  log("  hit per-track time cap");
}

async function clickPlaybarPlay(log) {
  let button = findPlaybarTransportButton();
  if (!button) {
    log("  ! play bar play button not found");
    return false;
  }
  if (buttonShowsPause(button)) {
    log("  pausing the play bar so the song can start from the beginning");
    forceClick(button);
    await sleep(350);
    rewindMediaToStart();
    await sleep(200);
    button = null;
    for (let attempt = 0; attempt < 15 && !stopRequested; attempt += 1) {
      const found = findPlaybarTransportButton();
      if (found && !buttonShowsPause(found)) {
        button = found;
        break;
      }
      await sleep(200);
    }
    if (!button || buttonShowsPause(button)) return false;
  } else {
    rewindMediaToStart();
  }
  log("  click: play bar play");
  forceClick(button);
  const deadline = Date.now() + 8000;
  let retried = false;
  while (Date.now() < deadline) {
    if (stopRequested) return false;
    const again = findPlaybarTransportButton();
    if (isPlaybarPlaying() || findPlayingMedia() || (again && buttonShowsPause(again))) return true;
    if (!retried && Date.now() > deadline - 6000) {
      retried = true;
      const retry = findPlaybarTransportButton();
      if (retry && !buttonShowsPause(retry)) forceClick(retry);
    }
    await sleep(200);
  }
  return false;
}

function playbarRootElement() {
  const titleNode = Array.from(document.querySelectorAll('[aria-label*="Playbar: Title"]')).find((el) => {
    const rect = el.getBoundingClientRect();
    return isShown(el) && rect.width > 24;
  });
  const start = titleNode || findPlaybarTransportButton();
  if (!start) return null;
  let scope = start.parentElement;
  let best = null;
  for (let depth = 0; depth < 8 && scope; depth += 1) {
    const rect = scope.getBoundingClientRect();
    if (rect.height > 240) break;
    if (rect.height >= 48 && rect.height <= 220) best = scope;
    scope = scope.parentElement;
  }
  return best;
}

function sidecarTrack(title, fallback) {
  const bar = readPlaybarTrack();
  const recorded = { title, id: "" };
  if (fallback && titleKey(fallback.title) === titleKey(title) && fallback.id) recorded.id = fallback.id;
  if (bar.title && titleKey(bar.title) === titleKey(title)) {
    return { title, id: bar.id || recorded.id };
  }
  return recorded;
}

function coverMatchesTrack(img, track) {
  if (!img || typeof isSunoCoverUrl !== "function") return false;
  const src = img.currentSrc || img.src;
  if (!isSunoCoverUrl(src)) return false;
  const rect = img.getBoundingClientRect();
  if (rect.width < 24 || rect.height < 24 || !isShown(img)) return false;
  const altTitle = typeof coverAltTitle === "function" ? coverAltTitle(img.alt || "") : "";
  if (altTitle && titleKey(altTitle) === titleKey(track.title)) return true;
  const root = playbarRootElement();
  if (!root || !root.contains(img)) return false;
  const bar = readPlaybarTrack();
  if (bar.title && titleKey(bar.title) !== titleKey(track.title)) return false;
  if (track.id && bar.id && bar.id !== track.id) return false;
  return true;
}

function findCoverImage(track) {
  const matches = [];
  for (const img of document.images) {
    if (!coverMatchesTrack(img, track)) continue;
    const alt = img.alt || "";
    let tier = 1;
    if (/^image for /i.test(alt)) tier = 3;
    else if (/ artwork$/i.test(alt)) tier = 2;
    const rect = img.getBoundingClientRect();
    matches.push({ img, tier, area: rect.width * rect.height });
  }
  matches.sort((a, b) => b.tier - a.tier || b.area - a.area);
  return matches.length ? matches[0].img : null;
}

function queryDeepAll(root, selector) {
  const out = [];
  const seen = new Set();
  const visit = (node) => {
    if (!node || seen.has(node) || typeof node.querySelectorAll !== "function") return;
    seen.add(node);
    for (const el of node.querySelectorAll(selector)) out.push(el);
    for (const el of node.querySelectorAll("*")) {
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(root);
  return out;
}

function elementContainsLibraryList(node) {
  if (!node || typeof node.querySelectorAll !== "function") return false;
  let plays = 0;
  for (const btn of node.querySelectorAll("button[aria-label]")) {
    if (!parseRowLabel(btn.getAttribute("aria-label") || "")) continue;
    plays += 1;
    if (plays >= 2) return true;
  }
  return false;
}

function isLibraryLyricsControl(el) {
  if (!el || typeof el.closest !== "function") return false;
  if (el.closest("button, [role='tab'], [role='tablist']")) return true;
  const role = typeof el.getAttribute === "function" ? el.getAttribute("role") : "";
  return role === "tab" || role === "button";
}

// The open song panel is the largest ancestor of its "Image for <title>" cover
// that still does not contain the library list or the play bar.
function songPanelRoot(title) {
  const wanted = titleKey(title);
  if (!wanted) return null;
  const imgs = queryDeepAll(document, "img").filter((img) => {
    const alt = img.alt || "";
    if (!/^image for /i.test(alt)) return false;
    const altTitle = typeof coverAltTitle === "function" ? coverAltTitle(alt) : "";
    return Boolean(altTitle) && titleKey(altTitle) === wanted;
  });
  imgs.sort((a, b) => Number(isShown(b)) - Number(isShown(a)));
  const img = imgs[0];
  if (!img) return null;
  let node = img.parentElement;
  let best = node;
  for (let depth = 0; depth < 16 && node && node !== document.body && node !== document.documentElement; depth += 1) {
    if (node.querySelector && node.querySelector('[aria-label*="Playbar: Title"]')) break;
    if (elementContainsLibraryList(node)) break;
    best = node;
    const role = typeof node.getAttribute === "function" ? node.getAttribute("role") : "";
    if (role === "dialog" || node.tagName === "DIALOG") break;
    node = node.parentElement;
  }
  return best;
}

function preservedLyricSpace(el) {
  try {
    const whiteSpace = getComputedStyle(el).whiteSpace;
    return whiteSpace === "pre" || whiteSpace === "pre-wrap" || whiteSpace === "pre-line";
  } catch (_) {
    return false;
  }
}

function lyricCandidateElements(panel) {
  if (!panel) return [];
  return queryDeepAll(panel, "div, p, pre").filter((el) => {
    if (isLibraryLyricsControl(el)) return false;
    if (el.querySelector && el.querySelector("button, [role='tab'], input, textarea")) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    let style;
    try {
      style = getComputedStyle(el);
    } catch (_) {
      return false;
    }
    if (!style || style.display === "none" || style.visibility === "hidden") return false;
    if (!preservedLyricSpace(el)) return false;
    const text = (el.innerText || "").trim();
    if (!text) return false;
    const lines = text.split(/\n/).filter((line) => line.trim()).length;
    if (lines >= 2 || text.length >= 12) return true;
    return typeof lyricsPresence === "function" && lyricsPresence(text) === "absent";
  });
}

function elementNearLyricsHeading(el) {
  let node = el;
  for (let depth = 0; depth < 5 && node; depth += 1) {
    const previous = node.previousElementSibling;
    if (previous) {
      const label = (previous.innerText || "").replace(/\s+/g, " ").trim();
      if (/^lyrics$/i.test(label)) return true;
    }
    node = node.parentElement;
  }
  return false;
}

// Inherited pre-wrap makes every ancestor look like the lyric block. Keep the
// longest block, and skip a wrapper whose child already holds almost all of it.
// A block sitting under a Lyrics heading wins over a longer style prompt.
function chooseLyricElement(candidates) {
  const labeled = candidates.filter(elementNearLyricsHeading);
  const pool = labeled.length ? labeled : candidates;
  const ranked = pool.slice().sort((a, b) => (b.innerText || "").length - (a.innerText || "").length);
  for (const el of ranked) {
    const length = (el.innerText || "").trim().length;
    const wrapper = pool.some((other) => {
      if (other === el || typeof el.contains !== "function" || !el.contains(other)) return false;
      const childLength = (other.innerText || "").trim().length;
      return length > 0 && childLength / length >= 0.85;
    });
    if (!wrapper) return el;
  }
  return ranked[0] || null;
}

function readPanelLyrics(panel) {
  const el = chooseLyricElement(lyricCandidateElements(panel));
  if (!el) return { lyrics: "", absent: false };
  const text = el.innerText || "";
  const presence = typeof lyricsPresence === "function" ? lyricsPresence(text) : "";
  if (presence === "lyrics" && typeof normalizeLyrics === "function") {
    const lyrics = normalizeLyrics(text);
    return lyrics ? { lyrics, absent: false } : { lyrics: "", absent: false };
  }
  if (presence === "absent") return { lyrics: "", absent: true };
  if (presence !== "lyrics" && typeof normalizeLyrics === "function") {
    const lyrics = normalizeLyrics(text);
    if (lyrics) return { lyrics, absent: false };
  }
  return { lyrics: "", absent: false };
}

function libraryScrollRoot() {
  const scroller = libraryScroller();
  if (!scroller || scroller === document.body || scroller === document.documentElement) return null;
  return scroller;
}

function libraryScrollOffset() {
  const library = libraryScrollRoot();
  return {
    library,
    top: library ? library.scrollTop : 0,
    windowY: window.scrollY || 0,
  };
}

function restoreLibraryOffset(saved) {
  if (!saved) return;
  if (saved.library && saved.library.scrollTop !== saved.top) saved.library.scrollTop = saved.top;
  if ((window.scrollY || 0) !== saved.windowY) window.scrollTo(0, saved.windowY);
}

function isLibraryScrollSurface(el) {
  if (!el) return false;
  if (el === document.body || el === document.documentElement || el === document.scrollingElement) return true;
  const library = libraryScrollRoot();
  if (library && (el === library || library.contains(el) || el.contains(library))) return true;
  return elementContainsLibraryList(el);
}

function panelScrollContainers(panel) {
  if (!panel) return [];
  const nodes = [panel, ...queryDeepAll(panel, "div, section, article, aside")];
  return nodes.filter((el) => {
    if (!el || isLibraryScrollSurface(el) || el.scrollHeight <= el.clientHeight + 16) return false;
    try {
      const style = getComputedStyle(el);
      return /auto|scroll|overlay/.test(`${style.overflowY} ${style.overflow}`);
    } catch (_) {
      return false;
    }
  });
}

function scrollersAtEnd(scrollers) {
  return scrollers.every((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 4);
}

function nudgePanelScroll(scrollers) {
  let moved = false;
  for (const el of scrollers) {
    const max = el.scrollHeight - el.clientHeight;
    if (el.scrollTop >= max - 2) continue;
    const next = Math.min(max, el.scrollTop + Math.max(160, Math.floor(el.clientHeight * 0.75)));
    if (next === el.scrollTop) continue;
    el.scrollTop = next;
    moved = true;
  }
  return moved;
}

function panelLooksLoading(panel) {
  if (!panel) return false;
  if (typeof panel.getAttribute === "function" && panel.getAttribute("aria-busy") === "true") return true;
  return queryDeepAll(panel, "[aria-busy='true'], [role='progressbar']").some((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  });
}

function panelContentSignature(panel, scrollers) {
  const raw = panel && panel.innerText ? panel.innerText : "";
  const stableText = raw.replace(/\d+:\d{2}/g, "").replace(/\d+(?:\.\d+)?%/g, "");
  const heights = scrollers.map((el) => el.scrollHeight).join(",");
  return `${stableText.length}:${heights}`;
}

// Song lyrics are the pre-wrap block in the open details panel, next to the
// "Image for <title>" cover. The library filter tab named Lyrics is not that
// text. Visible lyrics are returned immediately. An empty panel is watched for
// 4 seconds of unchanged content, scrolling only inside the song panel.
async function waitForLyricsText(track, log) {
  const libraryAtStart = libraryScrollOffset();
  let stableSince = 0;
  let lastSignature = "";
  let announcedWait = false;
  let announcedScroll = false;
  let resetPanelScroll = false;
  while (!stopRequested) {
    const panel = songPanelRoot(track.title);
    if (!panel) {
      if (!stableSince) stableSince = Date.now();
      else if (Date.now() - stableSince >= LYRICS_ABSENT_STABLE_MS) {
        restoreLibraryOffset(libraryAtStart);
        return "";
      }
      await sleep(LYRICS_POLL_MS);
      continue;
    }
    const reading = readPanelLyrics(panel);
      if (reading.lyrics) {
        restoreLibraryOffset(libraryAtStart);
        return reading.lyrics;
      }
      const scrollers = panelScrollContainers(panel);
      if (!resetPanelScroll) {
        for (const el of scrollers) el.scrollTop = 0;
        restoreLibraryOffset(libraryAtStart);
        resetPanelScroll = true;
      }
      if (!announcedWait) {
        log(`  waiting for lyrics in "${track.title}"`);
        announcedWait = true;
      }
      const atEnd = scrollersAtEnd(scrollers);
      if (!atEnd) {
        if (!announcedScroll) {
          log("  scrolling the song panel for lyrics");
          announcedScroll = true;
        }
        nudgePanelScroll(scrollers);
        restoreLibraryOffset(libraryAtStart);
      }
      const again = readPanelLyrics(panel);
      if (again.lyrics) {
        restoreLibraryOffset(libraryAtStart);
        return again.lyrics;
      }
      const signature = panelContentSignature(panel, scrollers);
      const loading = panelLooksLoading(panel);
      if (loading || !lastSignature || signature !== lastSignature) {
        stableSince = loading ? 0 : Date.now();
        lastSignature = loading ? "" : signature;
      } else if (Date.now() - stableSince >= LYRICS_ABSENT_STABLE_MS) {
        const finalRead = readPanelLyrics(panel);
        restoreLibraryOffset(libraryAtStart);
        return finalRead.lyrics || "";
      }
    await sleep(LYRICS_POLL_MS);
  }
  restoreLibraryOffset(libraryAtStart);
  return "";
}

function coverFetchUrl(src) {
  const url = new URL(src, location.href);
  url.searchParams.delete("width");
  url.searchParams.delete("height");
  return url.toString();
}

function collapsedText(el) {
  return String((el && (el.innerText || el.textContent)) || "")
    .replace(/\s+/g, " ")
    .trim();
}

function exactPanelLabel(root, word) {
  const wanted = String(word || "").toLowerCase();
  if (!root || !wanted) return [];
  return queryDeepAll(root, "div, span, p, h1, h2, h3, h4").filter((el) => {
    if (el.querySelector && el.querySelector("button")) return false;
    return collapsedText(el).toLowerCase() === wanted;
  });
}

function stylesToggleKind(span) {
  if (!span || !span.classList || !span.classList.contains("hxc-btn-content")) return "";
  if (!span.querySelector || !span.querySelector("svg")) return "";
  const text = collapsedText(span);
  if (/^show less\b/i.test(text)) return "expanded";
  if (/^show more\b/i.test(text)) return "collapsed";
  return "";
}

// The Styles block is the ancestor that has a "Styles" label and this toggle,
// and does not also contain the Lyrics label. Library "Show more" controls are
// outside the song panel.
function findStylesExpandControl(panel) {
  if (!panel) return null;
  const spans = queryDeepAll(panel, "span.hxc-btn-content");
  for (const span of spans) {
    const kind = stylesToggleKind(span);
    if (!kind) continue;
    const button = (typeof span.closest === "function" && span.closest("button")) || span;
    let node = button.parentElement;
    for (let depth = 0; depth < 8 && node && node !== panel.parentElement; depth += 1) {
      const hasStyles = exactPanelLabel(node, "styles").length > 0;
      const hasLyrics = exactPanelLabel(node, "lyrics").length > 0;
      if (hasStyles && !hasLyrics) return { kind, button, section: node };
      if (hasLyrics && !hasStyles) break;
      node = node.parentElement;
    }
  }
  return null;
}

function isStylesCopyButton(btn) {
  const aria = collapsedText({ innerText: btn.getAttribute("aria-label") || "" }).toLowerCase();
  const title = collapsedText({ innerText: btn.getAttribute("title") || "" }).toLowerCase();
  return aria === "copy styles to clipboard" || title === "copy styles to clipboard";
}

function findStylesCopyButton(panel) {
  if (!panel) return null;
  return queryDeepAll(panel, "button").find((btn) => isStylesCopyButton(btn)) || null;
}

async function ensureStylesExpanded(panel, log) {
  const control = findStylesExpandControl(panel);
  if (!control || control.kind === "expanded") {
    if (control && control.kind === "expanded") stylesExpandedThisPass = true;
    return;
  }
  log(stylesExpandedThisPass ? "  styles collapsed again — expanding" : "  expanding styles");
  control.button.click();
  stylesExpandedThisPass = true;
  const deadline = Date.now() + 1000;
  while (!stopRequested && Date.now() < deadline) {
    const again = findStylesExpandControl(panel);
    if (!again || again.kind === "expanded") return;
    await sleep(100);
  }
}

function readStylesBesideCopyButton(panel) {
  const button = findStylesCopyButton(panel);
  const row = button && button.parentElement;
  if (!row) return "";
  const parts = [];
  for (const child of row.children) {
    if (child === button || (typeof child.contains === "function" && child.contains(button))) continue;
    if (child.tagName === "BUTTON") continue;
    const text = collapsedText(child);
    if (!text || /^edit song details$/i.test(text)) continue;
    parts.push(String(child.innerText || child.textContent || "").trim());
  }
  return parts.join("\n").trim();
}

async function readClipboardText() {
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") return { ok: false, text: "" };
    const text = await navigator.clipboard.readText();
    return { ok: true, text: String(text ?? "") };
  } catch (_) {
    return { ok: false, text: "" };
  }
}

async function writeClipboardText(text) {
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") return false;
    await navigator.clipboard.writeText(String(text ?? ""));
    return true;
  } catch (_) {
    return false;
  }
}

function clickStylesCopyButton(button) {
  return new Promise((resolve) => {
    let captured = "";
    const onCopy = (event) => {
      try {
        const data = event.clipboardData && event.clipboardData.getData("text/plain");
        if (data) captured = String(data);
      } catch (_) {
        /* the page may use the async clipboard API instead */
      }
    };
    document.addEventListener("copy", onCopy, true);
    button.click();
    setTimeout(() => {
      document.removeEventListener("copy", onCopy, true);
      resolve(captured.trim());
    }, 80);
  });
}

// Show more first, then the Styles copy button. The lyrics copy button is never
// clicked. The previous clipboard is written back when it could be read.
async function readFullStyles(track, log) {
  const panel = songPanelRoot(track.title);
  if (!panel) return "";
  await ensureStylesExpanded(panel, log);
  if (stopRequested) return "";
  const current = songPanelRoot(track.title) || panel;
  const button = findStylesCopyButton(current);
  if (!button) return readStylesBesideCopyButton(current);
  const prior = await readClipboardText();
  const fromEvent = await clickStylesCopyButton(button);
  let changed = "";
  for (let attempt = 0; attempt < 5 && !stopRequested; attempt += 1) {
    const after = await readClipboardText();
    if (after.ok && (!prior.ok || after.text !== prior.text)) {
      changed = after.text.trim();
      break;
    }
    await sleep(80);
  }
  if (prior.ok) {
    const restored = await writeClipboardText(prior.text);
    if (!restored) log("  could not restore the clipboard");
  } else {
    log("  could not read the previous clipboard, so it was not restored");
  }
  const styles = (changed || fromEvent).trim();
  if (styles) return styles;
  log("  styles clipboard was empty — using the expanded styles text");
  return readStylesBesideCopyButton(songPanelRoot(track.title) || current);
}

async function saveLyricsFile(track, filename, log, opts) {
  if (!panelShowsTitle(track.title)) {
    log(`  song panel is not showing "${track.title}" — not saving lyrics`);
    return false;
  }
  let styles = "";
  if (!stopRequested) {
    try {
      styles = await readFullStyles(track, log);
    } catch (err) {
      log(`  ! styles were not copied: ${err && err.message ? err.message : err}`);
      styles = "";
    }
  }
  if (stopRequested) return false;
  const lyrics = await waitForLyricsText(track, log);
  if (stopRequested) return false;
  if (!panelShowsTitle(track.title)) {
    log(`  song panel is not showing "${track.title}" — not saving lyrics`);
    return false;
  }
  const text =
    typeof composeSidecarText === "function" ? composeSidecarText(styles, lyrics) : String(lyrics || "").trim();
  // visit:true must not suppress the write. Only an existing txt sets download false.
  if (opts && opts.download === false) {
    log("  lyrics already saved — not downloading");
    return false;
  }
  if (!text) {
    log(`  no lyrics or styles for "${track.title}" — skipped text file`);
    return false;
  }
  const response = await chrome.runtime.sendMessage({
    target: "background",
    type: "saveSidecar",
    filename,
    extension: "txt",
    text,
  });
  if (!response || !response.ok) {
    log(`  ! lyrics save failed: ${response && response.error ? response.error : "unknown"}`);
    return false;
  }
  log(`  saved ${filename}.txt`);
  return true;
}

async function saveCoverFromSrc(src, filename, log) {
  const fetched = coverFetchUrl(src);
  if (!isSunoCoverUrl(fetched)) throw new Error("cover URL is not the song image host");
  const response = await fetch(fetched, { credentials: "omit" });
  if (!response.ok) throw new Error(`cover fetch HTTP ${response.status}`);
  const mime = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const extension = imageExtension(mime, fetched, bytes);
  if (!extension || !bytes.byteLength) throw new Error("cover response was not a jpeg, png, or webp");
  const saved = await chrome.runtime.sendMessage({
    target: "background",
    type: "saveSidecar",
    filename,
    extension,
    buffer: bytes,
    mimeType: mime || `image/${extension === "jpg" ? "jpeg" : extension}`,
  });
  if (!saved || !saved.ok) {
    log(`  ! cover save failed: ${saved && saved.error ? saved.error : "unknown"}`);
    return false;
  }
  log(`  saved ${filename}.${extension}`);
  return true;
}

function panelShowsTitle(title) {
  const wanted = titleKey(title);
  if (!wanted || typeof coverAltTitle !== "function") return false;
  return Array.from(document.images).some((img) => {
    if (!isShown(img)) return false;
    const alt = img.alt || "";
    if (!/^image for /i.test(alt)) return false;
    const altTitle = coverAltTitle(alt);
    return Boolean(altTitle) && titleKey(altTitle) === wanted;
  });
}

function insidePlayControl(el) {
  const button = el && typeof el.closest === "function" ? el.closest("button") : null;
  if (!button) return false;
  return Boolean(parseRowLabel(button.getAttribute("aria-label") || ""));
}

// Colons and parentheses stay part of the title. titleKey maps ":" to the
// filename lookalike on both sides, so "Track: Name (Part)" still matches.
function textMatchesTitle(text, title) {
  const wanted = titleKey(title);
  if (!wanted || !text) return false;
  const pieces = [String(text)];
  for (const line of String(text).split(/\n/)) pieces.push(line);
  for (const piece of pieces) {
    const flat = piece.replace(/\s+/g, " ").trim();
    if (!flat) continue;
    const keyed = titleKey(flat);
    if (!keyed) continue;
    if (keyed === wanted) return true;
    if (keyed.startsWith(wanted) && (keyed.length === wanted.length || keyed[wanted.length] === " ")) return true;
  }
  return false;
}

function titleClickTarget(row, title) {
  if (!row || typeof row.querySelectorAll !== "function") return null;
  const candidates = [];
  for (const el of row.querySelectorAll("a, span, p, h1, h2, h3, h4, div")) {
    if (isRowPlayButton(el) || insidePlayControl(el)) continue;
    if (!textMatchesTitle(el.innerText || "", title)) continue;
    if (!isShown(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) continue;
    candidates.push({ el, area: rect.width * rect.height });
  }
  candidates.sort((a, b) => a.area - b.area);
  return candidates.length ? candidates[0].el : null;
}

function rowBodyClickTarget(row) {
  if (!row || isRowPlayButton(row) || insidePlayControl(row)) return null;
  if (!isShown(row)) return null;
  const rect = row.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return null;
  return row;
}

// Prefer the title text. If that node is missing, click the row body — never Play.
function clickTargetForSongRow(button, title) {
  const row = panelRow(button) || (button && button.parentElement);
  let node = row;
  for (let depth = 0; depth < 8 && node; depth += 1) {
    if (depth > 0 && elementContainsLibraryList(node)) break;
    if (!isRowPlayButton(node) && !insidePlayControl(node)) {
      const match = titleClickTarget(node, title);
      if (match) return match;
    }
    node = node.parentElement;
  }
  return rowBodyClickTarget(row);
}

function clickElement(el) {
  if (!el || isRowPlayButton(el) || insidePlayControl(el)) return;
  const link = typeof el.closest === "function" ? el.closest("a[href]") : null;
  const guard = (event) => {
    if (link && link.contains(event.target)) event.preventDefault();
  };
  if (link) document.addEventListener("click", guard, true);
  try {
    // Do not scrollIntoView. That scrolls the virtualized library and clips page 1.
    el.click();
  } finally {
    if (link) document.removeEventListener("click", guard, true);
  }
}

async function waitForSongPanel(title, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!stopRequested && Date.now() < deadline) {
    if (panelShowsTitle(title)) return true;
    await sleep(PANEL_OPEN_POLL_MS);
  }
  return !stopRequested && panelShowsTitle(title);
}

let lastLibraryAnchor = 0;

function rememberLibraryAnchor() {
  const library = libraryScrollRoot();
  if (library) lastLibraryAnchor = library.scrollTop;
}

function topmostVisibleLibraryRow() {
  let best = null;
  let bestTop = Infinity;
  for (const row of collectVisibleRows()) {
    if (!row.button || typeof row.button.getBoundingClientRect !== "function") continue;
    const rect = row.button.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) continue;
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
    if (rect.top < bestTop) {
      bestTop = rect.top;
      best = row;
    }
  }
  return best;
}

// The virtualized library ignores later row lookups until a song title has been
// clicked. Click the topmost visible title, never its Play button, and never
// scrollIntoView (that clips page 1).
async function selectFirstLibrarySong(log) {
  const row = topmostVisibleLibraryRow();
  if (!row) {
    log("Could not select the first library song.");
    return false;
  }
  const target = clickTargetForSongRow(row.button, row.title);
  if (!target) {
    log("Could not select the first library song.");
    return false;
  }
  log("Selecting the first library song.");
  clickElement(target);
  rememberLibraryAnchor();
  await sleep(250);
  return true;
}

function rowIntersectsViewport(button) {
  if (!button || typeof button.getBoundingClientRect !== "function") return false;
  const rect = button.getBoundingClientRect();
  return rect.width >= 8 && rect.height >= 8 && rect.bottom > 0 && rect.top < window.innerHeight;
}

function buttonInLibraryViewport(title) {
  const button = findVisibleButtonByTitle(title);
  if (!button || !rowIntersectsViewport(button)) return null;
  return button;
}

function librarySignatureShares(left, right) {
  if (!left || !right) return false;
  const keys = new Set(left.split("\n"));
  return right.split("\n").some((key) => key && keys.has(key));
}

async function waitForLibraryRow(title, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let found = buttonInLibraryViewport(title);
  while (!found && !stopRequested && Date.now() < deadline) {
    await sleep(PANEL_OPEN_POLL_MS);
    found = buttonInLibraryViewport(title);
  }
  return found;
}

// One viewport on the library scroll parent. Not scrollIntoView.
function nudgeLibraryScroll(scroller, direction) {
  if (!scroller) return false;
  const before = scroller.scrollTop;
  const step = Math.max(1, scroller.clientHeight || 0);
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const next = direction === "up" ? Math.max(0, before - step) : Math.min(max, before + step);
  if (next - before < 2 && before - next < 2) return false;
  scroller.scrollTop = next;
  return Math.abs(scroller.scrollTop - before) >= 2;
}

async function findButtonForPanel(title, log) {
  const visible = buttonInLibraryViewport(title);
  if (visible) {
    rememberLibraryAnchor();
    return visible;
  }
  if (stopRequested) return null;
  log(`  looking for "${title}" to open its panel`);
  const found = await revealLibraryRow(title, log);
  if (found) {
    rememberLibraryAnchor();
    return found;
  }
  if (!stopRequested) log(`  missed "${title}" — continuing with the next song`);
  return null;
}

// Page Down with the library list focused. If that key does not change the list's
// scrollTop, step the same scroller one viewport. If that page skips the row, Page Up once.
// A few attempts that mount nothing fail this song only.
async function revealLibraryRow(title, log) {
  const ATTEMPT_CAP = 6;
  const STABLE_LIMIT = 3;
  let previous = visibleLibrarySignature();
  let stable = 0;
  for (let i = 0; i < ATTEMPT_CAP && !stopRequested; i += 1) {
    const already = buttonInLibraryViewport(title);
    if (already) return already;
    let scroller = focusLibraryScroller();
    const beforeTop = scroller ? scroller.scrollTop : 0;
    const beforeSig = visibleLibrarySignature();
    const keyed = await pressLibraryKey("PageDown", log);
    let found = await waitForLibraryRow(title, 800);
    if (found) return found;
    scroller = libraryListScroller() || scroller;
    const afterKeyTop = scroller ? scroller.scrollTop : beforeTop;
    const afterKeySig = visibleLibrarySignature();
    const keyMoved = Boolean(scroller) && Math.abs(afterKeyTop - beforeTop) >= 2;
    const rowsChanged = afterKeySig !== beforeSig;
    if (rowsChanged && beforeSig && !librarySignatureShares(beforeSig, afterKeySig)) {
      log("  Page Down passed the row. Pressing Page Up.");
      const upBefore = scroller ? scroller.scrollTop : 0;
      if (keyed) await pressLibraryKey("PageUp", log);
      found = await waitForLibraryRow(title, 800);
      if (found) return found;
      scroller = libraryListScroller() || scroller;
      if (scroller && Math.abs(scroller.scrollTop - upBefore) < 2 && nudgeLibraryScroll(scroller, "up")) {
        found = await waitForLibraryRow(title, 800);
        if (found) return found;
      }
    } else if (!keyMoved && !rowsChanged) {
      log("  Page Down did not move the library. Scrolling the list one viewport.");
      if (nudgeLibraryScroll(scroller, "down")) found = await waitForLibraryRow(title, 800);
      if (found) return found;
      const nudgedSig = visibleLibrarySignature();
      if (nudgedSig !== beforeSig && beforeSig && !librarySignatureShares(beforeSig, nudgedSig)) {
        log("  Page Down passed the row. Pressing Page Up.");
        if (nudgeLibraryScroll(scroller, "up")) found = await waitForLibraryRow(title, 800);
        if (found) return found;
      }
    }
    const signature = visibleLibrarySignature();
    const topNow = scroller ? scroller.scrollTop : beforeTop;
    if (signature === previous && Math.abs(topNow - beforeTop) < 2) {
      stable += 1;
      if (stable >= STABLE_LIMIT) return null;
    } else {
      stable = 0;
      previous = signature;
    }
  }
  return buttonInLibraryViewport(title);
}

function playbarTitleElement() {
  const nodes = Array.from(document.querySelectorAll('[aria-label*="Playbar: Title"]')).filter(isShown);
  return nodes.length ? nodes[nodes.length - 1] : null;
}

function panelRow(button) {
  let node = button && button.parentElement;
  for (let depth = 0; depth < 8 && node; depth += 1) {
    if (node.querySelector && node.querySelector("img") && !isRowPlayButton(node) && !insidePlayControl(node)) {
      return node;
    }
    node = node.parentElement;
  }
  return button ? button.parentElement : null;
}

async function openSongPanel(title, log, opts) {
  if (panelShowsTitle(title)) return true;
  if (stopRequested) return false;
  const allowLibraryScroll = !opts || opts.allowLibraryScroll !== false;
  const button = allowLibraryScroll ? await findButtonForPanel(title, log) : findVisibleButtonByTitle(title);
  if (stopRequested) return false;
  if (button) {
    const target = clickTargetForSongRow(button, title);
    if (target) {
      log(`  opening song panel for "${title}"`);
      clickElement(target);
    }
  } else if (!allowLibraryScroll) {
    const bar = readPlaybarTrack();
    const el = playbarTitleElement();
    if (bar.title && titleKey(bar.title) === titleKey(title) && el) {
      log(`  opening song panel from the play bar for "${title}"`);
      clickElement(el);
    }
  }
  // Previously `if (!clicked) return false` logged "song panel did not show"
  // and the lyrics loop advanced immediately. Wait out the panel instead.
  const opened = await waitForSongPanel(title, PANEL_OPEN_WAIT_MS);
  if (!opened) log(`  song panel did not show "${title}"`);
  return opened;
}

async function ensureSongPanel(title, log, opts) {
  if (stopRequested) return false;
  if (panelShowsTitle(title)) return true;
  return openSongPanel(title, log, opts);
}

function playbackSnapshot() {
  let title = "";
  try {
    title = readPlaybarTrack().title || "";
  } catch (_) {
    title = "";
  }
  return { playing: Boolean(findPlayingMedia() || isPlaybarPlaying()), title };
}

async function restorePlayback(snapshot, log, allowLibraryScroll) {
  if (!snapshot || stopRequested) return;
  const playingNow = Boolean(findPlayingMedia() || isPlaybarPlaying());
  if (snapshot.playing && !playingNow) {
    const button = findPlaybarTransportButton();
    if (button && !buttonShowsPause(button)) {
      log("  returning to playback");
      button.click();
      await sleep(300);
    }
    return;
  }
  if (!snapshot.playing && playingNow) {
    for (const media of getMediaElements()) {
      try {
        if (!media.paused) media.pause();
      } catch (_) {
        /* ignore */
      }
    }
    if (findPlayingMedia() || isPlaybarPlaying()) {
      const pauseBtn = findActivePauseButton();
      if (pauseBtn) pauseBtn.click();
    }
    log("  paused playback the panel click started");
  }
}

async function resolveSidecarPlan(filename, log, opts) {
  if (opts && opts.plan) return opts.plan;
  try {
    const options = await getOptions();
    const files = await fetchSavedSidecars(options.saveFolder);
    return typeof planSidecarSave === "function"
      ? planSidecarSave(files, filename)
      : { saveLyrics: true, saveCover: true, skipSong: false };
  } catch (err) {
    log(
      `  ! could not check saved lyrics and covers, so nothing was downloaded: ${
        err && err.message ? err.message : err
      }`
    );
    return null;
  }
}

async function saveLyricsAndCover(track, filename, log, coverSrc, opts) {
  const plan = await resolveSidecarPlan(filename, log, opts);
  if (!plan) return { failed: true };
  const downloadLyrics = Boolean(plan.saveLyrics);
  const downloadCover = Boolean(plan.saveCover);
  const visit = Boolean(opts && opts.visit);
  if (!downloadLyrics && !downloadCover && !visit) {
    log(`  lyrics and cover already saved for "${track.title}"`);
    return { failed: false, skippedDownload: true };
  }

  const allowLibraryScroll = !opts || opts.allowLibraryScroll !== false;
  const snapshot = playbackSnapshot();
  const shouldOpen = visit || downloadLyrics || downloadCover;
  let downloaded = false;
  let openFailed = false;
  try {
    if (shouldOpen && !panelShowsTitle(track.title)) {
      const opened = await ensureSongPanel(track.title, log, { allowLibraryScroll });
      if (stopRequested) return { failed: false, skippedDownload: false };
      if (!opened) {
        log(`  could not open "${track.title}" — continuing with the next song`);
        openFailed = true;
      }
    }
    if (stopRequested) return { failed: false, skippedDownload: false };
    if (!downloadLyrics && !downloadCover) log(`  lyrics and cover already saved for "${track.title}" — not downloading`);
    else if (downloadLyrics && !downloadCover) log("  cover already saved — downloading lyrics");
    else if (!downloadLyrics && downloadCover) log("  lyrics already saved — downloading cover");

    if (visit || downloadLyrics) {
      if (!panelShowsTitle(track.title)) {
        if (downloadLyrics) log(`  not saving lyrics — panel is not showing "${track.title}"`);
      } else {
        try {
          const wrote = await saveLyricsFile(track, filename, log, { download: downloadLyrics });
          if (wrote) downloaded = true;
        } catch (err) {
          log(`  ! lyrics save failed: ${err && err.message ? err.message : err}`);
        }
      }
    }
    if (stopRequested) return { failed: false, skippedDownload: false };
    if (!downloadCover) {
      return {
        failed: openFailed && downloadLyrics && !downloaded,
        skippedDownload: !downloadLyrics && !downloadCover,
      };
    }

    const image = findCoverImage(track);
    const src = (image ? image.currentSrc || image.src : "") || coverSrc || "";
    if (!src) {
      log(`  no cover image for "${track.title}"`);
      return {
        failed: openFailed && downloadLyrics && !downloaded,
        skippedDownload: false,
      };
    }
    try {
      const wroteCover = await saveCoverFromSrc(src, filename, log);
      if (wroteCover) downloaded = true;
    } catch (err) {
      log(`  ! cover save failed: ${err && err.message ? err.message : err}`);
    }
  } finally {
    if (shouldOpen) await restorePlayback(snapshot, log, allowLibraryScroll);
  }
  return {
    failed: openFailed && (downloadLyrics || downloadCover) && !downloaded,
    skippedDownload: !downloadLyrics && !downloadCover,
  };
}

function rowOfButton(button) {
  let node = button;
  for (let depth = 0; depth < 8 && node; depth += 1) {
    if (typeof node.querySelector === "function" && node.querySelector("img")) return node;
    node = node.parentElement;
  }
  return null;
}

function coverSrcInRow(button, title) {
  const row = rowOfButton(button);
  if (!row || typeof isSunoCoverUrl !== "function" || typeof coverAltTitle !== "function") return "";
  const wanted = titleKey(title);
  const matched = Array.from(row.querySelectorAll("img")).find((img) => {
    const altTitle = coverAltTitle(img.alt || "");
    return altTitle && titleKey(altTitle) === wanted && isSunoCoverUrl(img.currentSrc || img.src);
  });
  return matched ? matched.currentSrc || matched.src : "";
}

const sidecarListOffset = new Map();

function foldTitleKey(title) {
  return titleKey(title).toLowerCase();
}

function harvestVisibleSidecars(intoMap) {
  const library = libraryScrollRoot();
  const offset = library ? library.scrollTop : 0;
  for (const row of collectVisibleRows()) {
    const fold = foldTitleKey(row.title);
    if (!fold) continue;
    if (!sidecarListOffset.has(fold)) sidecarListOffset.set(fold, offset);
    const coverSrc = coverSrcInRow(row.button, row.title);
    const previous = intoMap.get(fold);
    if (!previous) {
      intoMap.set(fold, { title: row.title, coverSrc });
    } else if (!previous.coverSrc && coverSrc) {
      previous.coverSrc = coverSrc;
    }
  }
}

async function discoverSidecars(log) {
  sidecarListOffset.clear();
  const scan = await scanLibraryFromTop(log, (map) => harvestVisibleSidecars(map));
  const discovered = scan.discovered;
  for (const [fold, item] of scan.upward) {
    const previous = discovered.get(fold);
    if (!previous) discovered.set(fold, item);
    else if (!previous.coverSrc && item.coverSrc) previous.coverSrc = item.coverSrc;
  }
  log(`Scrolled through the library, found ${discovered.size} unique tracks.`);
  return Array.from(discovered.values());
}

async function runLyricsAndCovers(log) {
  stylesExpandedThisPass = false;
  try {
  if (!location.pathname.startsWith("/me")) {
    log("Open suno.com/me — lyrics and covers are read from your library.");
    await setState({ status: "idle", failedAt: Date.now(), mode: "meta" });
    return;
  }

  const options = await getOptions();
  let items = await discoverSidecars(log);
  if (stopRequested) {
    log("Lyrics and covers stopped.");
    await setState({ status: "idle", stoppedAt: Date.now(), mode: "meta" });
    return;
  }

  const discoveredTotal = items.length;
  if (!discoveredTotal) {
    log("No tracks found. Are you on suno.com/me and logged in?");
    await setState({ status: "idle", queue: [], finishedAt: Date.now(), discoveredTotal: 0, mode: "meta" });
    return;
  }

  if (options.maxTracks && options.maxTracks > 0) {
    items = items.slice(0, options.maxTracks);
    log(`Limiting to the first ${items.length} of ${discoveredTotal} tracks (Options → Max tracks).`);
  }

  let sidecarFiles = null;
  try {
    sidecarFiles = await fetchSavedSidecars(options.saveFolder);
    log(`Checking saved lyrics and covers in "${options.saveFolder}".`);
  } catch (err) {
    log(`  ! could not check saved lyrics and covers: ${err && err.message ? err.message : err}`);
    log("Lyrics and covers stopped without downloading, so existing files are left alone.");
    await setState({ status: "idle", failedAt: Date.now(), mode: "meta" });
    return;
  }

  // A WAV on the recorded-song list is not lyrics or a cover. An existing
  // lyric file or cover skips that download only. The song is still opened.
  // Duplicate names in this run are handled once.
  const seen = new Set();
  const results = [];
  const startedAt = Date.now();
  await setState({
    status: "capturing",
    mode: "meta",
    queue: results,
    currentIndex: 0,
    discoveredTotal,
    startedAt,
  });

  if (!stopRequested) {
    await returnLibraryToTop(log);
    if (!stopRequested) await selectFirstLibrarySong(log);
  }

  for (let i = 0; i < items.length; i++) {
    let current = null;
    try {
      current = await getState();
    } catch (err) {
      log(`  ! could not read session state, continuing: ${err && err.message ? err.message : err}`);
      current = { status: "capturing" };
    }
    if (stopRequested || !current || current.status === "idle") {
      log("Lyrics and covers stopped.");
      break;
    }
    const item = items[i];
    const fold = foldTitleKey(item.title);
    if (!fold || seen.has(fold)) {
      if (fold && seen.has(fold)) log(`Skipping duplicate in this run: ${item.title}`);
      continue;
    }
    seen.add(fold);

    const filename = buildRelativePath(options.saveFolder, options.filenamePrefix || "", item.title);
    const plan =
      typeof planSidecarSave === "function"
        ? planSidecarSave(sidecarFiles, filename)
        : { skipSong: false, saveLyrics: true, saveCover: true, hasLyrics: false, hasCover: false };

    log(`Lyrics and cover (${i + 1}/${items.length}): ${item.title}`);
    try {
      await setState({
        status: "capturing",
        mode: "meta",
        queue: results,
        currentIndex: i,
        currentTitle: item.title,
        discoveredTotal,
        startedAt,
      });
    } catch (err) {
      log(`  ! could not update session state, continuing: ${err && err.message ? err.message : err}`);
    }

    try {
      const outcome = await saveLyricsAndCover({ title: item.title, id: "" }, filename, log, item.coverSrc, {
        allowLibraryScroll: true,
        plan,
        visit: true,
      });
      results.push({
        title: item.title,
        done: true,
        failed: Boolean(outcome && outcome.failed),
        skipped: Boolean(outcome && outcome.skippedDownload && !outcome.failed),
      });
    } catch (err) {
      log(`  ! error saving lyrics/cover for "${item.title}": ${err && err.message ? err.message : err}`);
      results.push({ title: item.title, done: true, failed: true });
    }
  }

  await setState({
    status: "idle",
    mode: "meta",
    queue: results,
    finishedAt: Date.now(),
    discoveredTotal,
  });
  const saved = results.filter((entry) => entry.done && !entry.failed && !entry.skipped).length;
  const skipped = results.filter((entry) => entry.skipped).length;
  const failed = results.filter((entry) => entry.failed).length;
  log(`Lyrics and covers finished — ${saved} saved, ${skipped} skipped, ${failed} failed, ${discoveredTotal} found.`);
  } finally {
    try {
      await chrome.runtime.sendMessage({ target: "background", type: "endSession" });
    } catch (_) {
      /* debugger already detached, or the worker is gone */
    }
  }
}

async function recordPlaybarTrack(track, log) {
  if (stopRequested) return false;

  const startResponse = await chrome.runtime.sendMessage({
    target: "background",
    type: "startRecording",
    title: track.title,
  });
  if (!startResponse || !startResponse.ok) {
    log(`  ! recorder failed to start: ${startResponse && startResponse.error ? startResponse.error : "unknown"}`);
    return false;
  }

  await sleep(RECORDER_WARMUP_MS);
  if (stopRequested) {
    try {
      await chrome.runtime.sendMessage({ target: "background", type: "discardRecording" });
    } catch (_) {
      /* offscreen may already be gone after Stop */
    }
    return false;
  }

  const playing = await clickPlaybarPlay(log);
  if (!playing) {
    log(`  ! Suno never started playing "${track.title}" — discarding`);
    await chrome.runtime.sendMessage({ target: "background", type: "discardRecording" });
    return false;
  }
  log("  site playback confirmed");

  const playingNow = readPlaybarTrack();
  const identity = playingNow.title ? playingNow : track;
  await waitForPlaybarChange(identity, log);

  if (stopRequested) {
    log("  stop requested — discarding the in-progress track");
    pauseAllPlayback(log);
    try {
      await chrome.runtime.sendMessage({ target: "background", type: "discardRecording" });
    } catch (_) {
      /* offscreen may already be gone after Stop */
    }
    return false;
  }

  pauseAllPlayback(log);
  await sleep(250);

  const options = await getOptions();
  const filename = buildRelativePath(options.saveFolder, options.filenamePrefix || "", track.title);
  const stopResponse = await chrome.runtime.sendMessage({
    target: "background",
    type: "stopRecordingAndSave",
    filename,
  });
  if (!stopResponse || !stopResponse.ok) {
    log(`  ! save failed: ${stopResponse && stopResponse.error ? stopResponse.error : "unknown"}`);
    return false;
  }
  const savedAs = (stopResponse && stopResponse.extension) || "wav";
  log(`  saved ${filename}.${savedAs}`);
  await saveLyricsAndCover(sidecarTrack(track.title, identity), filename, log, "", {
    allowLibraryScroll: false,
  });
  return true;
}

async function runOneSong(log) {
  const track = await waitForPlaybarTitle(log);
  if (!track) {
    if (await supersededOneSong()) return;
    log("Capture stopped.");
    await setState({ status: "idle", stoppedAt: Date.now(), mode: "one" });
    try {
      await chrome.runtime.sendMessage({ target: "background", type: "endSession" });
    } catch (_) {
      /* ignore */
    }
    return;
  }

  log(`One song: "${track.title}". Recording until the play bar changes.`);
  const startedAt = Date.now();
  await setState({
    status: "capturing",
    queue: [],
    currentIndex: 0,
    currentTitle: track.title,
    discoveredTotal: 1,
    startedAt,
    mode: "one",
  });

  let success = false;
  try {
    success = await recordPlaybarTrack(track, log);
  } catch (err) {
    log(`  ! error capturing "${track.title}": ${err && err.message ? err.message : err}`);
    try {
      await chrome.runtime.sendMessage({ target: "background", type: "discardRecording" });
    } catch (_) {
      /* ignore */
    }
    success = false;
  }

  if (stopRequested) {
    log("Capture stopped.");
    await setState({ status: "idle", stoppedAt: Date.now(), mode: "one" });
    try {
      await chrome.runtime.sendMessage({ target: "background", type: "endSession" });
    } catch (_) {
      /* ignore */
    }
    return;
  }

  if (success) {
    try {
      await rememberRecordedTitle(track.title);
    } catch (err) {
      log(`  ! could not update the recorded-song list: ${err && err.message ? err.message : err}`);
    }
  }

  const results = [{ title: track.title, done: true, failed: !success }];
  await setState({ status: "idle", queue: results, finishedAt: Date.now(), discoveredTotal: 1, mode: "one" });
  await chrome.runtime.sendMessage({ target: "background", type: "endSession" });
  log(success ? `Saved "${track.title}".` : `Did not save "${track.title}".`);
}

async function playRowAndWait(title, log) {
  const button = await findButtonByTitle(title, log);
  if (!button) {
    log(`  ! could not find row for "${title}"`);
    return false;
  }

  button.scrollIntoView({ block: "center", behavior: "instant" });
  await sleep(300);
  hoverRow(button);
  await sleep(150);

  const startResponse = await chrome.runtime.sendMessage({
    target: "background",
    type: "startRecording",
    title,
  });
  if (!startResponse || !startResponse.ok) {
    log(`  ! recorder failed to start: ${startResponse && startResponse.error ? startResponse.error : "unknown"}`);
    return false;
  }

  // Warm up the recorder before triggering playback so the intro isn't clipped.
  await sleep(RECORDER_WARMUP_MS);

  if (stopRequested) {
    try {
      await chrome.runtime.sendMessage({ target: "background", type: "discardRecording" });
    } catch (_) {
      /* offscreen may already be gone after Stop */
    }
    return false;
  }

  const playing = await clickPlayForTitle(title, button, log);
  if (!playing) {
    log(`  ! Suno never entered a playing state for "${title}" — discarding`);
    await chrome.runtime.sendMessage({ target: "background", type: "discardRecording" });
    return false;
  }
  log("  site playback confirmed");
  const libraryIdentity = sidecarTrack(title, null);

  const started = await waitForPlaybackStart(Math.min(PLAYBACK_START_TIMEOUT_MS, 8000), log);
  log(`  capturing (${started.ok ? started.via : "row/playbar state"})`);

  await waitForTrackEnd(started.media || findPlayingMedia(), log);

  if (stopRequested) {
    log("  stop requested — discarding the in-progress track");
    pauseAllPlayback(log);
    try {
      await chrome.runtime.sendMessage({ target: "background", type: "discardRecording" });
    } catch (_) {
      /* offscreen may already be gone after Stop */
    }
    return false;
  }

  // Pause the instant the track boundary is hit — BEFORE the WAV encode +
  // download below — so Suno's auto-advanced next track can't play under (and
  // hitch) that heavy work or bleed into the capture. The next track is started
  // explicitly by the next loop iteration once this download has settled.
  pauseAllPlayback(log);
  await sleep(250);

  const options = await getOptions();
  const prefix = options.filenamePrefix || "";
  const filename = buildRelativePath(options.saveFolder, prefix, title);
  const stopResponse = await chrome.runtime.sendMessage({
    target: "background",
    type: "stopRecordingAndSave",
    filename,
  });
  if (!stopResponse || !stopResponse.ok) {
    log(`  ! save failed: ${stopResponse && stopResponse.error ? stopResponse.error : "unknown"}`);
    return false;
  }
  const savedAs = (stopResponse && stopResponse.extension) || "wav";
  log(`  saved ${filename}.${savedAs}`);
  await saveLyricsAndCover(sidecarTrack(title, libraryIdentity), filename, log, "", {
    allowLibraryScroll: false,
  });
  return true;
}

async function runCaptureSession(log) {
  const options = await getOptions();
  let titles = await discoverAllTitles(log);

  if (stopRequested) {
    log("Capture stopped.");
    await setState({ status: "idle", stoppedAt: Date.now() });
    await chrome.runtime.sendMessage({ target: "background", type: "endSession" });
    return;
  }

  const discoveredTotal = titles.length;

  if (!discoveredTotal) {
    log("No tracks found. Are you on suno.com/me and logged in?");
    await setState({ status: "idle", queue: [], finishedAt: Date.now(), discoveredTotal: 0 });
    await chrome.runtime.sendMessage({ target: "background", type: "endSession" });
    return;
  }

  if (options.maxTracks && options.maxTracks > 0) {
    titles = titles.slice(0, options.maxTracks);
    log(`Limiting session to first ${titles.length} of ${discoveredTotal} tracks (Options → Max tracks).`);
  }

  const state = await getState();
  const alreadyDone = new Set(
    (state.queue || [])
      .filter((t) => t.done && !t.failed)
      .map((t) => titleKey(t.title))
  );

  if (options.skipCaptured !== false) {
    const previouslyCaptured = await collectPreviouslyCapturedKeys(options, log);
    for (const key of previouslyCaptured) alreadyDone.add(key);
  }

  const results = [];
  const startedAt = state.startedAt || Date.now();
  await setState({
    status: "capturing",
    queue: results,
    currentIndex: 0,
    discoveredTotal,
    startedAt,
  });

  if (!stopRequested) await returnLibraryToTop(log);

  for (let i = 0; i < titles.length; i++) {
    const title = titles[i];
    const key = titleKey(title);

    const current = await getState();
    if (stopRequested || !current || current.status === "idle") {
      log("Capture stopped.");
      break;
    }

    const wavAlreadySaved = options.skipCaptured !== false && alreadyDone.has(key);
    log(
      wavAlreadySaved
        ? `Opening (${i + 1}/${titles.length}): ${title}`
        : `Playing (${i + 1}/${titles.length}): ${title}`
    );
    if (wavAlreadySaved) log("  WAV already saved — not downloading");
    await setState({
      status: "capturing",
      queue: results,
      currentIndex: i,
      currentTitle: title,
      discoveredTotal,
      startedAt,
    });

    if (wavAlreadySaved) {
      const filename = buildRelativePath(options.saveFolder, options.filenamePrefix || "", title);
      try {
        const outcome = await saveLyricsAndCover({ title, id: "" }, filename, log, "", {
          allowLibraryScroll: true,
          visit: true,
        });
        results.push({
          title,
          done: true,
          failed: Boolean(outcome && outcome.failed),
          skipped: Boolean(outcome && outcome.skippedDownload && !outcome.failed),
        });
      } catch (err) {
        log(`  ! error opening "${title}": ${err && err.message ? err.message : err}`);
        results.push({ title, done: true, failed: true });
      }
      if (stopRequested) {
        log("Capture stopped.");
        break;
      }
      await setState({
        status: "capturing",
        queue: results,
        currentIndex: i,
        discoveredTotal,
        startedAt,
      });
      await sleep(800);
      continue;
    }

    let success = false;
    try {
      success = await playRowAndWait(title, log);
    } catch (err) {
      log(`  ! error capturing "${title}": ${err && err.message ? err.message : err}`);
      try {
        await chrome.runtime.sendMessage({ target: "background", type: "discardRecording" });
      } catch (_) {
        /* ignore */
      }
      success = false;
    }

    // A Stop during the track must win — do NOT re-write "capturing" below,
    // which would clobber the popup's idle state and let the session roll on.
    if (stopRequested) {
      log("Capture stopped.");
      break;
    }

    results.push({ title, done: true, failed: !success });
    if (success) {
      alreadyDone.add(key);
      try {
        await rememberRecordedTitle(title);
      } catch (err) {
        log(`  ! could not update the recorded-song list: ${err && err.message ? err.message : err}`);
      }
    }
    await setState({
      status: "capturing",
      queue: results,
      currentIndex: i,
      discoveredTotal,
      startedAt,
    });
    await sleep(800);
  }

  await setState({ status: "idle", queue: results, finishedAt: Date.now(), discoveredTotal });
  await chrome.runtime.sendMessage({ target: "background", type: "endSession" });
  const ok = results.filter((t) => t.done && !t.failed && !t.skipped).length;
  const skipped = results.filter((t) => t.skipped).length;
  const failed = results.filter((t) => t.failed).length;
  log(`Capture session complete — ${ok} saved, ${skipped} not re-downloaded, ${failed} failed, ${discoveredTotal} discovered.`);
}

function log(message) {
  console.log("Suno Recorder:", message);
  try {
    if (!runtimeAlive()) return;
    chrome.storage.local.set({
      sunoCaptureLastLog: message,
      sunoCaptureHeartbeat: Date.now(),
    });
  } catch (_) {
    /* extension reloaded — ignore */
  }
}

async function start() {
  if (SCRIPT_GENERATION !== globalThis.__sunoRecorderGeneration) return;
  if (sessionRunning) {
    startPending = true;
    return;
  }
  if (!runtimeAlive()) {
    console.warn("Suno Recorder:", RELOAD_HINT);
    return;
  }

  let state;
  try {
    state = await getState();
  } catch (err) {
    if (isContextInvalidatedError(err) || !runtimeAlive()) {
      console.warn("Suno Recorder:", RELOAD_HINT);
      return;
    }
    throw err;
  }

  // Only begin on explicit "collecting" — ignore "starting" (stream still wiring up).
  if (!state || state.status !== "collecting") return;
  const mode = state.mode === "one" ? "one" : state.mode === "meta" ? "meta" : "library";
  if (mode === "library" && !location.pathname.startsWith("/me")) {
    log("Open suno.com/me — library capture only runs on your library page.");
    return;
  }

  sessionRunning = true;
  stopRequested = false;
  startSessionHeartbeat();
  try {
    if (mode === "one") await runOneSong(log);
    else if (mode === "meta") await runLyricsAndCovers(log);
    else await runCaptureSession(log);
  } catch (err) {
    if (isContextInvalidatedError(err) || !runtimeAlive()) {
      console.warn("Suno Recorder:", RELOAD_HINT);
      return;
    }
    log(`Capture crashed: ${err && err.message ? err.message : err}`);
    try {
      await setState({ status: "idle", failedAt: Date.now() });
      await chrome.storage.local.set({
        sunoCaptureError: err && err.message ? err.message : String(err),
      });
      await chrome.runtime.sendMessage({ target: "background", type: "endSession" });
    } catch (_) {
      /* ignore cleanup failures after crash */
    }
  } finally {
    stopSessionHeartbeat();
    sessionRunning = false;
    if (startPending) {
      startPending = false;
      void start();
    }
  }
}

start();

chrome.storage.onChanged.addListener((changes, area) => {
  if (SCRIPT_GENERATION !== globalThis.__sunoRecorderGeneration) return;
  if (!runtimeAlive()) return;
  if (area === "local" && changes.sunoCaptureState) {
    const newState = changes.sunoCaptureState.newValue;
    if (newState && newState.status === "collecting") {
      start();
    }
    // Honor Stop immediately. The popup writes { status: "idle", stoppedAt } —
    // flag it so an in-flight session aborts the current track right away.
    if (sessionRunning && (!newState || userEndedSession(newState))) {
      stopRequested = true;
    }
  }
});
