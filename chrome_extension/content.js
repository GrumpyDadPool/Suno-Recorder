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

let sessionRunning = false;
// titleKey -> approx discovery scroll index (helps remount jumps)
const titleScrollIndex = new Map();

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
  return { maxTracks: 0, filenamePrefix: "", skipCaptured: true, monitorAudio: false };
}

/** Match key for library rows — strips markdown/punctuation the same way for scan + remount. */
function titleKey(title) {
  const normalized = (title || "")
    .replace(/[*_`~]/g, "")
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return sanitizeTitle(normalized);
}

function parseRowLabel(label) {
  const match = (label || "").match(ROW_LABEL_REGEX);
  if (!match) return null;
  return { action: match[1], title: match[2] };
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
  anchor.scrollIntoView({ block: "end", behavior: "instant" });
  if (Math.abs(scroller.scrollTop - before) < 2) {
    window.scrollBy(0, Math.floor(window.innerHeight * 0.85));
  }
}

function scrollLibraryUp() {
  const buttons = getRowButtons();
  const anchor = buttons[0];
  const scroller = libraryScroller();
  const before = scroller.scrollTop;
  const step = Math.max(120, Math.floor(scroller.clientHeight * 0.75));
  scroller.scrollTop = Math.max(0, scroller.scrollTop - step);
  if (anchor) anchor.scrollIntoView({ block: "start", behavior: "instant" });
  if (Math.abs(scroller.scrollTop - before) < 2) {
    window.scrollBy(0, -Math.floor(window.innerHeight * 0.85));
  }
}

async function scrollLibraryToTop() {
  const scroller = libraryScroller();
  for (let i = 0; i < 20; i++) {
    scroller.scrollTop = 0;
    window.scrollTo(0, 0);
    const first = getRowButtons()[0];
    if (first) first.scrollIntoView({ block: "start", behavior: "instant" });
    await sleep(80);
    if (scroller.scrollTop <= 2) break;
  }
  await sleep(200);
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
  const discovered = new Map();
  harvestVisibleTitles(discovered, 0);
  log(`Starting scroll — ${discovered.size} tracks visible before scrolling.`);

  let stableRounds = 0;
  let lastSize = discovered.size;

  for (let i = 0; i < MAX_SCROLL_ATTEMPTS; i++) {
    assertAlive();
    scrollLibraryDown();

    // Poll for newly mounted virtualized rows (count may stay flat while titles change).
    const pollStart = Date.now();
    while (Date.now() - pollStart < 3500) {
      assertAlive();
      harvestVisibleTitles(discovered, i + 1);
      if (discovered.size > lastSize) break;
      await sleep(250);
    }
    harvestVisibleTitles(discovered, i + 1);

    if (discovered.size > lastSize) {
      log(`  scroll attempt ${i + 1}: ${discovered.size} unique titles so far (+${discovered.size - lastSize})`);
      lastSize = discovered.size;
      stableRounds = 0;
    } else {
      stableRounds++;
      log(`  scroll attempt ${i + 1}: ${discovered.size} unique titles (no new titles this attempt)`);
      if (stableRounds >= 8) break;
    }
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
    const label = btn.getAttribute("aria-label") || "";
    return /^(Playbar:\s*)?Pause\b/i.test(label) || /^Pause\b/i.test(label);
  });
}

async function waitForPlaybackStart(timeoutMs, log) {
  const start = Date.now();
  let lastMediaCount = getMediaElements().length;
  while (Date.now() - start < timeoutMs) {
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

  await scrollLibraryToTop();
  hit = findVisibleButtonByTitle(title);
  if (hit) return hit;

  for (let i = 0; i < BUTTON_FIND_SCROLL_ATTEMPTS; i++) {
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

async function playRowAndWait(title, log) {
  const button = await findButtonByTitle(title, log);
  if (!button) {
    log(`  ! could not find row for "${title}"`);
    return false;
  }

  button.scrollIntoView({ block: "center", behavior: "instant" });
  await sleep(250);

  const startResponse = await chrome.runtime.sendMessage({
    target: "background",
    type: "startRecording",
    title,
  });
  if (!startResponse || !startResponse.ok) {
    log(`  ! recorder failed to start: ${startResponse && startResponse.error ? startResponse.error : "unknown"}`);
    return false;
  }

  const label = parseRowLabel(button.getAttribute("aria-label") || "");
  if (label && label.action === "Pause") {
    // Already the active row — restart from the beginning.
    button.click();
    await sleep(400);
    const playBtn = findVisibleButtonByTitle(title) || button;
    playBtn.click();
  } else {
    button.click();
  }
  await sleep(150);
  // Some rows need a second click if the first only selects the row.
  if (!findPlayingMedia() && !isPlaybarPlaying()) {
    const again = findVisibleButtonByTitle(title) || button;
    again.click();
  }

  const started = await waitForPlaybackStart(PLAYBACK_START_TIMEOUT_MS, log);
  if (!started.ok) {
    log(`  ! playback never started for "${title}" — discarding`);
    await chrome.runtime.sendMessage({ target: "background", type: "discardRecording" });
    return false;
  }
  log(`  playback started via ${started.via}`);

  await waitForTrackEnd(started.media, log);
  await sleep(600);

  const options = await getOptions();
  const prefix = options.filenamePrefix || "";
  const filename = `${prefix}${sanitizeTitle(title)}`;
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
  return true;
}

async function runCaptureSession(log) {
  const options = await getOptions();
  let titles = await discoverAllTitles(log);
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

  const results = [];
  await setState({
    status: "capturing",
    queue: results,
    currentIndex: 0,
    discoveredTotal,
  });

  for (let i = 0; i < titles.length; i++) {
    const title = titles[i];
    const key = titleKey(title);

    if (options.skipCaptured !== false && alreadyDone.has(key)) {
      log(`Skipping (already captured): ${title}`);
      results.push({ title, done: true, failed: false, skipped: true });
      continue;
    }

    const current = await getState();
    if (!current || current.status === "idle") {
      log("Capture stopped.");
      return;
    }

    log(`Playing (${i + 1}/${titles.length}): ${title}`);
    await setState({
      status: "capturing",
      queue: results,
      currentIndex: i,
      currentTitle: title,
      discoveredTotal,
    });

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

    results.push({ title, done: true, failed: !success });
    if (success) alreadyDone.add(key);
    await setState({
      status: "capturing",
      queue: results,
      currentIndex: i,
      discoveredTotal,
    });
    await sleep(800);
  }

  await setState({ status: "idle", queue: results, finishedAt: Date.now(), discoveredTotal });
  await chrome.runtime.sendMessage({ target: "background", type: "endSession" });
  const ok = results.filter((t) => t.done && !t.failed && !t.skipped).length;
  const failed = results.filter((t) => t.failed).length;
  log(`Capture session complete — ${ok} saved, ${failed} failed, ${discoveredTotal} discovered.`);
}

function log(message) {
  console.log("Suno Recorder:", message);
  try {
    if (!runtimeAlive()) return;
    chrome.storage.local.set({ sunoCaptureLastLog: message });
  } catch (_) {
    /* extension reloaded — ignore */
  }
}

async function start() {
  if (SCRIPT_GENERATION !== globalThis.__sunoRecorderGeneration) return;
  if (sessionRunning) return;
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
  if (!location.pathname.startsWith("/me")) {
    log("Open suno.com/me — capture only runs on your library page.");
    return;
  }

  sessionRunning = true;
  try {
    await runCaptureSession(log);
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
    sessionRunning = false;
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
  }
});
