// Runs on suno.com/me. Stays on this one page for the whole capture session —
// no navigating to individual track pages. Clicking each row's own inline play
// button avoids "Similar" sidebar contamination and keeps the tab-capture
// stream alive across the whole library pass.
//
// Row aria-label pattern (verified against real page HTML): `Play "Track Name"`.

const ROW_TITLE_REGEX = /^Play "(.*)"$/s;
const AUDIO_SELECTOR = "audio";
const MAX_SCROLL_ATTEMPTS = 100;
const MAX_TRACK_WAIT_MS = 10 * 60 * 1000;
const PLAYBACK_START_TIMEOUT_MS = 20_000;

let sessionRunning = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForSelector(selector, timeoutMs) {
  return new Promise((resolve) => {
    const existing = document.querySelector(selector);
    if (existing) {
      resolve(existing);
      return;
    }
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      resolve(document.querySelector(selector));
    }, timeoutMs);
  });
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

function collectUniqueRows() {
  const seen = new Set();
  const rows = [];
  for (const button of getRowPlayButtons()) {
    const title = extractTitle(button);
    const key = sanitizeTitle(title);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ title, key, button });
  }
  return rows;
}

async function waitForCountToGrow(getCount, previousCount, maxWaitMs, pollIntervalMs = 300) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (getCount() !== previousCount) return true;
    await sleep(pollIntervalMs);
  }
  return false;
}

async function scrollToLoadAll(log) {
  let stableRounds = 0;
  let lastCount = getRowPlayButtons().length;
  log(`Starting scroll — ${lastCount} tracks visible before scrolling.`);

  for (let i = 0; i < MAX_SCROLL_ATTEMPTS; i++) {
    const buttons = getRowPlayButtons();
    const lastButton = buttons[buttons.length - 1];
    if (lastButton) {
      lastButton.scrollIntoView({ block: "end", behavior: "instant" });
    } else {
      window.scrollTo(0, document.body.scrollHeight);
    }

    const grew = await waitForCountToGrow(() => getRowPlayButtons().length, lastCount, 4000);
    const newCount = getRowPlayButtons().length;
    log(`  scroll attempt ${i + 1}: ${newCount} tracks so far${grew ? "" : " (no growth this attempt)"}`);

    if (!grew) {
      stableRounds++;
      if (stableRounds >= 5) break;
    } else {
      stableRounds = 0;
      lastCount = newCount;
    }
  }

  const total = collectUniqueRows().length;
  log(`Scrolled through the library, found ${total} unique tracks.`);
  return total;
}

async function waitForPlaybackStart(audio, timeoutMs) {
  if (!audio.paused && audio.currentTime > 0) return true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ok);
    };
    const onPlaying = () => finish(true);
    const onTimeUpdate = () => {
      if (audio.currentTime > 0.05) finish(true);
    };
    const cleanup = () => {
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("timeupdate", onTimeUpdate);
    };
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("timeupdate", onTimeUpdate);
    setTimeout(() => finish(false), timeoutMs);
  });
}

function findButtonByTitle(title) {
  const wanted = sanitizeTitle(title);
  for (const button of getRowPlayButtons()) {
    if (sanitizeTitle(extractTitle(button)) === wanted) return button;
  }
  return null;
}

async function playRowAndWait(title, log) {
  const button = findButtonByTitle(title);
  if (!button) {
    log(`  ! row disappeared for "${title}"`);
    return false;
  }

  button.scrollIntoView({ block: "center", behavior: "instant" });
  await sleep(200);

  await chrome.runtime.sendMessage({ target: "background", type: "startRecording", title });
  button.click();

  const audio = await waitForSelector(AUDIO_SELECTOR, 15000);
  if (!audio) {
    log(`  ! no audio element appeared after clicking play for "${title}"`);
    await chrome.runtime.sendMessage({
      target: "background",
      type: "discardRecording",
    });
    return false;
  }

  const started = await waitForPlaybackStart(audio, PLAYBACK_START_TIMEOUT_MS);
  if (!started) {
    log(`  ! playback never started for "${title}" — discarding`);
    await chrome.runtime.sendMessage({ target: "background", type: "discardRecording" });
    return false;
  }

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    audio.addEventListener("ended", finish, { once: true });
    setTimeout(finish, MAX_TRACK_WAIT_MS);
  });

  await sleep(500);
  const options = await getOptions();
  const prefix = options.filenamePrefix || "";
  const filename = `${prefix}${sanitizeTitle(title)}`;
  await chrome.runtime.sendMessage({
    target: "background",
    type: "stopRecordingAndSave",
    filename,
  });
  return true;
}

async function runCaptureSession(log) {
  const options = await getOptions();
  await scrollToLoadAll(log);

  let rows = collectUniqueRows();
  const discoveredTotal = rows.length;
  if (options.maxTracks && options.maxTracks > 0) {
    rows = rows.slice(0, options.maxTracks);
    log(`Limiting session to first ${rows.length} of ${discoveredTotal} tracks (Options → Max tracks).`);
  }

  const state = await getState();
  const alreadyDone = new Set(
    (state.queue || [])
      .filter((t) => t.done && !t.failed)
      .map((t) => sanitizeTitle(t.title))
  );

  const results = [...(state.queue || [])];
  await setState({
    status: "capturing",
    queue: results,
    currentIndex: 0,
    discoveredTotal,
  });

  for (let i = 0; i < rows.length; i++) {
    const { title, key } = rows[i];

    if (options.skipCaptured !== false && alreadyDone.has(key)) {
      log(`Skipping (already captured): ${title}`);
      continue;
    }

    const current = await getState();
    if (!current || current.status === "idle") {
      log("Capture stopped.");
      return;
    }

    log(`Playing (${i + 1}/${rows.length}): ${title}`);
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
      log(`  ! error capturing "${title}": ${err}`);
      try {
        await chrome.runtime.sendMessage({ target: "background", type: "discardRecording" });
      } catch (_) {
        /* ignore */
      }
      success = false;
    }

    results.push({ title, done: true, failed: !success });
    alreadyDone.add(key);
    await setState({
      status: "capturing",
      queue: results,
      currentIndex: i,
      discoveredTotal,
    });
    await sleep(1000);
  }

  await setState({ status: "idle", queue: results, finishedAt: Date.now(), discoveredTotal });
  await chrome.runtime.sendMessage({ target: "background", type: "endSession" });
  log("Capture session complete.");
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
