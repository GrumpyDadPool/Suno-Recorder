// Runs on suno.com/me. Stays on this one page for the whole capture session
// — no navigating to individual track pages at all, which is what this file
// used to do. That approach had two real problems, both fixed by staying
// here instead:
//   - a track's own page has a "Similar" recommendations sidebar showing
//     OTHER people's tracks; anything that touched it risked picking up
//     someone else's song
//   - full-page navigation between tracks turned out not to reliably
//     preserve the tab's captured audio stream, causing capture to stop
//     after the first track
// Clicking each row's own inline play button (verified against real page
// HTML — see ROW_TITLE_REGEX below) avoids both: no navigation ever
// happens, so neither problem can occur.
//
// The row's own aria-label already contains the track's exact title
// (`Play "Track Name"`), verified against real page HTML — no separate
// title-scraping step needed, and it doubles as the selector: only these
// inline row buttons match this pattern, nothing else on the page does.

const ROW_TITLE_REGEX = /^Play "(.*)"$/s;
const AUDIO_SELECTOR = "audio";
const MAX_SCROLL_ATTEMPTS = 100;
const MAX_TRACK_WAIT_MS = 10 * 60 * 1000;

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

async function waitForCountToGrow(getCount, previousCount, maxWaitMs, pollIntervalMs = 300) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (getCount() !== previousCount) return true;
    await sleep(pollIntervalMs);
  }
  return false;
}

async function scrollToLoadAll(log) {
  // Earlier version waited a fixed 800ms after each scroll before checking
  // whether more tracks loaded — fine against instant mocked data in
  // testing, but real network-based lazy-loading can take longer,
  // especially for a big library. Now waits up to 4s per attempt for
  // genuine growth, and needs 5 consecutive misses (not 3) before deciding
  // it's actually reached the end — more patient on both counts. Also logs
  // every attempt now, not just every third, so if this stalls again there's
  // an actual record of the attempt count and running total to look at
  // instead of guessing blind.
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
      if (stableRounds >= 5) break; // no new tracks for 5 scrolls in a row, even after waiting 4s each = reached the end
    } else {
      stableRounds = 0;
      lastCount = newCount;
    }
  }

  const total = getRowPlayButtons().length;
  log(`Scrolled through the library, found ${total} tracks.`);
  return total;
}

async function playRowAndWait(button, title, log) {
  await chrome.runtime.sendMessage({ target: "background", type: "startRecording", title });
  button.click();

  const audio = await waitForSelector(AUDIO_SELECTOR, 15000);
  if (!audio) {
    log(`  ! no audio element appeared after clicking play for "${title}"`);
    await chrome.runtime.sendMessage({ target: "background", type: "stopRecordingAndSave", filename: sanitizeTitle(title) });
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
    setTimeout(finish, MAX_TRACK_WAIT_MS); // hard cap so a stuck page can't hang forever
  });

  await sleep(500); // small buffer so the tail of the track isn't clipped
  await chrome.runtime.sendMessage({ target: "background", type: "stopRecordingAndSave", filename: sanitizeTitle(title) });
  return true;
}

async function runCaptureSession(log) {
  await scrollToLoadAll(log);
  const total = getRowPlayButtons().length;

  const state = await getState();
  const alreadyDone = new Set((state.queue || []).filter((t) => t.done && !t.failed).map((t) => t.title));

  const results = state.queue || [];
  for (let i = 0; i < total; i++) {
    const buttons = getRowPlayButtons(); // re-query each time in case the DOM shifted
    const button = buttons[i];
    if (!button) continue;

    const title = extractTitle(button);
    if (alreadyDone.has(title)) {
      log(`Skipping (already captured): ${title}`);
      continue;
    }

    const current = await getState();
    if (current.status === "idle") {
      log("Capture stopped.");
      return;
    }

    log(`Playing (${i + 1}/${total}): ${title}`);
    const success = await playRowAndWait(button, title, log);
    results.push({ title, done: true, failed: !success });
    await setState({ status: "capturing", queue: results, currentIndex: i });
    await sleep(1000); // brief pause between tracks
  }

  await setState({ status: "idle", queue: results, finishedAt: Date.now() });
  await chrome.runtime.sendMessage({ target: "background", type: "endSession" });
  log("Capture session complete.");
}

// simple logger that also stores the latest line for the popup, since
// there's no console visible to the user during normal use
function log(message) {
  console.log("Suno Capture:", message);
  chrome.storage.local.set({ sunoCaptureLastLog: message });
}

async function start() {
  const state = await getState();
  if (!state || state.status === "idle") return;
  if (!location.pathname.startsWith("/me")) return;
  await runCaptureSession(log);
}

start();

// Catches the case where the popup sets status='collecting' while this
// script is already loaded and idle on /me.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.sunoCaptureState) {
    const newState = changes.sunoCaptureState.newValue;
    if (newState && (newState.status === "collecting")) {
      start();
    }
  }
});
