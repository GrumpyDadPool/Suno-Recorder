// Runs on suno.com/me. Stays on this page for the whole capture session.
//
// Suno's library list is virtualized: only ~20–30 row play buttons exist in
// the DOM at once. Scrolling replaces rows rather than appending, so a raw
// button COUNT never grows past one viewport — that previously made discovery
// stop at ~24 tracks and then only "see" whatever was still mounted.
// Discovery therefore accumulates unique titles while scrolling.
//
// Row aria-label pattern: `Play "Track Name"`.

const ROW_TITLE_REGEX = /^Play "(.*)"$/s;
const MAX_SCROLL_ATTEMPTS = 200;
const MAX_TRACK_WAIT_MS = 10 * 60 * 1000;
const PLAYBACK_START_TIMEOUT_MS = 25_000;
const BUTTON_FIND_SCROLL_ATTEMPTS = 80;

let sessionRunning = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get("sunoCaptureState", (result) => {
      resolve(result.sunoCaptureState || { status: "idle" });
    });
  });
}

function setState(state) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ sunoCaptureState: state }, resolve);
  });
}

async function getOptions() {
  const response = await chrome.runtime.sendMessage({ target: "background", type: "getOptions" });
  if (response && response.ok && response.options) return response.options;
  return { maxTracks: 0, filenamePrefix: "", skipCaptured: true, monitorAudio: false };
}

function getRowPlayButtons() {
  return Array.from(document.querySelectorAll("button[aria-label]")).filter((btn) =>
    ROW_TITLE_REGEX.test(btn.getAttribute("aria-label") || "")
  );
}

function extractTitle(button) {
  const label = button.getAttribute("aria-label") || "";
  const match = label.match(ROW_TITLE_REGEX);
  return match ? match[1] : "Untitled";
}

function collectVisibleRows() {
  const seen = new Set();
  const rows = [];
  for (const button of getRowPlayButtons()) {
    const title = extractTitle(button);
    const key = sanitizeTitle(title);
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

function scrollLibraryDown() {
  const buttons = getRowPlayButtons();
  const anchor = buttons[buttons.length - 1] || buttons[0];
  if (!anchor) {
    window.scrollBy(0, Math.floor(window.innerHeight * 0.85));
    return;
  }
  const scroller = getScrollParent(anchor);
  const before = scroller.scrollTop;
  // Prefer scrolling the real list container; fall back to bringing the last row into view.
  if (scroller && scroller !== document.body) {
    scroller.scrollTop = Math.min(scroller.scrollTop + Math.floor(scroller.clientHeight * 0.9), scroller.scrollHeight);
  }
  anchor.scrollIntoView({ block: "end", behavior: "instant" });
  if (Math.abs(scroller.scrollTop - before) < 2) {
    window.scrollBy(0, Math.floor(window.innerHeight * 0.85));
  }
}

function harvestVisibleTitles(intoMap) {
  let added = 0;
  for (const row of collectVisibleRows()) {
    if (!intoMap.has(row.key)) {
      intoMap.set(row.key, row.title);
      added++;
    }
  }
  return added;
}

async function discoverAllTitles(log) {
  const discovered = new Map();
  harvestVisibleTitles(discovered);
  log(`Starting scroll — ${discovered.size} tracks visible before scrolling.`);

  let stableRounds = 0;
  let lastSize = discovered.size;

  for (let i = 0; i < MAX_SCROLL_ATTEMPTS; i++) {
    scrollLibraryDown();

    // Poll for newly mounted virtualized rows (count may stay flat while titles change).
    const pollStart = Date.now();
    while (Date.now() - pollStart < 3500) {
      harvestVisibleTitles(discovered);
      if (discovered.size > lastSize) break;
      await sleep(250);
    }
    harvestVisibleTitles(discovered);

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
  const wanted = sanitizeTitle(title);
  const direct = getRowPlayButtons().find((btn) => sanitizeTitle(extractTitle(btn)) === wanted);
  if (direct) return direct;

  // Virtualized list: scroll from top until the row remounts.
  log(`  row not mounted for "${title}" — scrolling to find it`);
  const first = getRowPlayButtons()[0];
  if (first) {
    const scroller = getScrollParent(first);
    scroller.scrollTop = 0;
    first.scrollIntoView({ block: "start", behavior: "instant" });
    await sleep(250);
  }

  for (let i = 0; i < BUTTON_FIND_SCROLL_ATTEMPTS; i++) {
    const hit = getRowPlayButtons().find((btn) => sanitizeTitle(extractTitle(btn)) === wanted);
    if (hit) return hit;
    scrollLibraryDown();
    await sleep(280);
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

  button.click();
  await sleep(150);
  // Some rows need a second click if the first only selects the row.
  if (!findPlayingMedia() && !isPlaybarPlaying()) {
    button.click();
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
  log(`  saved ${filename}.webm`);
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
      .map((t) => sanitizeTitle(t.title))
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
    const key = sanitizeTitle(title);

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
  chrome.storage.local.set({ sunoCaptureLastLog: message });
}

async function start() {
  if (sessionRunning) return;
  const state = await getState();
  if (!state || state.status === "idle") return;
  if (!location.pathname.startsWith("/me")) return;

  sessionRunning = true;
  try {
    await runCaptureSession(log);
  } finally {
    sessionRunning = false;
  }
}

start();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.sunoCaptureState) {
    const newState = changes.sunoCaptureState.newValue;
    if (newState && newState.status === "collecting") {
      start();
    }
  }
});
