const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const errorEl = document.getElementById("error");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const meterEl = document.getElementById("meter");
const progressWrap = document.getElementById("progressWrap");
const progressBar = document.getElementById("progressBar");
const optionsLink = document.getElementById("optionsLink");
const oneSongBtn = document.getElementById("oneSongBtn");
const lyricsBtn = document.getElementById("lyricsBtn");

const ONE_SONG_PROMPT = "Click the song so it shows on the bottom play bar.";
// Arms tab capture only. The One song wait for a play-bar title is not covered
// by this timer. Stop is the only way to cancel that wait.
const START_TIMEOUT_MS = 20_000;
const STALE_SESSION_MS = 2 * 60 * 1000;

function parseSunoTabUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const host = parsed.hostname.toLowerCase();
    const isSunoHost = host === "suno.com" || host.endsWith(".suno.com");
    if (parsed.protocol !== "https:" || !isSunoHost) {
      return null;
    }
    return parsed;
  } catch (_) {
    return null;
  }
}

function isSunoLibraryPath(pathname) {
  return pathname === "/me" || pathname.startsWith("/me/");
}

function setBusy(isBusy) {
  startBtn.disabled = isBusy;
  oneSongBtn.disabled = isBusy;
  lyricsBtn.disabled = isBusy;
  meterEl.classList.toggle("active", isBusy);
}

function render(state, error, lastLog) {
  const busy = state && (state.status === "starting" || state.status === "collecting" || state.status === "capturing");
  setBusy(Boolean(busy));

  if (!state || state.status === "idle") {
    const finished = state && state.finishedAt;
    if (finished && state.queue) {
      const done = state.queue.filter((t) => t.done && !t.failed).length;
      const failed = state.queue.filter((t) => t.failed).length;
      statusEl.textContent = `Done · ${done} saved${failed ? `, ${failed} failed` : ""} / ${state.queue.length}`;
      progressWrap.hidden = false;
      progressBar.style.width = "100%";
    } else {
      statusEl.textContent = "Ready";
      progressWrap.hidden = true;
      progressBar.style.width = "0%";
    }
  } else if (state.status === "starting") {
    statusEl.textContent = state.mode === "one"
      ? (state.prompt || ONE_SONG_PROMPT)
      : "Starting capture…";
    progressWrap.hidden = false;
    progressBar.style.width = "4%";
  } else if (state.status === "collecting") {
    statusEl.textContent = state.mode === "one"
      ? (state.prompt || ONE_SONG_PROMPT)
      : state.mode === "meta"
        ? "Reading lyrics and covers…"
        : "Scanning library…";
    progressWrap.hidden = false;
    progressBar.style.width = "8%";
  } else if (state.status === "capturing") {
    const total = state.discoveredTotal || state.queue.length || 0;
    const done = (state.queue || []).filter((t) => t.done).length;
    const current = state.queue && state.queue[state.currentIndex];
    const label = state.currentTitle || (typeof current === "string" ? current : current && current.title);
    const action = state.mode === "meta" ? "Lyrics and covers" : "Recording";
    statusEl.textContent = total
      ? `${action} ${Math.min(done + 1, total)} / ${total}${label ? ` · ${label}` : ""}`
      : `${action}${label ? ` · ${label}` : ""}`;
    progressWrap.hidden = false;
    const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 12;
    progressBar.style.width = `${Math.max(pct, 10)}%`;
  } else {
    statusEl.textContent = String(state.status);
  }

  logEl.textContent = lastLog || "";
  errorEl.textContent = error ? error : "";
}

async function refresh() {
  const result = await chrome.storage.local.get([
    "sunoCaptureState",
    "sunoCaptureError",
    "sunoCaptureLastLog",
    "sunoCaptureHeartbeat",
  ]);
  await maybeClearStaleSession(result.sunoCaptureState, result.sunoCaptureHeartbeat);
  const latest = await chrome.storage.local.get([
    "sunoCaptureState",
    "sunoCaptureError",
    "sunoCaptureLastLog",
  ]);
  render(latest.sunoCaptureState, latest.sunoCaptureError, latest.sunoCaptureLastLog);
}

async function maybeClearStaleSession(state, heartbeat) {
  // Liveness is the heartbeat the content script writes while scanning / capturing.
  // An empty queue is normal for a long library scroll and the first-track hunt.
  if (!isSessionStale(state, heartbeat, Date.now(), STALE_SESSION_MS)) {
    return;
  }
  await chrome.storage.local.set({
    sunoCaptureState: { status: "idle", resetAt: Date.now(), resetReason: "stale-session" },
    sunoCaptureError: "Previous session looked stuck and was reset. Try Start recording again.",
  });
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { target: "content", type: "ping" });
    if (pong && pong.ok) return;
  } catch (_) {
    /* not injected yet — common after Reload extension without refreshing the tab */
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["title_utils.js", "recorded_log.js", "sidecar_utils.js", "content.js"],
  });
}

async function beginSession(mode) {
  errorEl.textContent = "";
  statusEl.textContent = mode === "one" ? ONE_SONG_PROMPT : "Starting capture…";
  setBusy(true);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      throw new Error("Couldn't find the active tab.");
    }
    const parsed = parseSunoTabUrl(tab.url || "");
    if (!parsed) {
      throw new Error(
        mode === "one"
          ? "Open suno.com, click One song, then click the song so it shows on the bottom play bar."
          : "Open suno.com/me in this tab first, then click Start recording."
      );
    }

    await chrome.storage.local.remove(["sunoCaptureError", "sunoCaptureLastLog"]);

    // Stop any in-page session left over from a previous run, then re-arm.
    await chrome.storage.local.set({
      sunoCaptureState: { status: "idle", resetAt: Date.now() },
    });
    try {
      await chrome.runtime.sendMessage({ target: "background", type: "endSession" });
    } catch (_) {
      /* ignore */
    }

    await chrome.storage.local.set({
      sunoCaptureState: {
        status: "starting",
        queue: [],
        currentIndex: 0,
        startedAt: Date.now(),
        mode,
        prompt: mode === "one" ? ONE_SONG_PROMPT : "",
      },
    });

    const response = await withTimeout(
      chrome.runtime.sendMessage({
        target: "background",
        type: "startSession",
        tabId: tab.id,
      }),
      START_TIMEOUT_MS,
      "Timed out starting tab audio capture. Reload the extension, refresh the Suno tab, and try again."
    );

    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "unknown error starting session");
    }

    // Make sure the page script is alive (reload extension ≠ refresh page).
    // One song stays on this page so the bottom play bar can update here.
    await ensureContentScript(tab.id);

    await chrome.storage.local.set({
      sunoCaptureState: {
        status: "collecting",
        queue: [],
        currentIndex: 0,
        startedAt: Date.now(),
        mode,
        prompt: mode === "one" ? ONE_SONG_PROMPT : "",
      },
    });

    if (mode !== "one" && !isSunoLibraryPath(parsed.pathname)) {
      await chrome.tabs.update(tab.id, { url: "https://suno.com/me" });
    }

    statusEl.textContent = mode === "one" ? ONE_SONG_PROMPT : "Scanning library…";
  } catch (err) {
    let current = null;
    try {
      const stored = await chrome.storage.local.get("sunoCaptureState");
      current = stored.sunoCaptureState || null;
    } catch (_) {
      current = null;
    }
    // Capture already armed and the content script owns the wait. A late
    // startup timeout must not idle the session or close the stream.
    if (current && (current.status === "collecting" || current.status === "capturing")) {
      return;
    }
    const message = err && err.message ? err.message : String(err);
    errorEl.textContent = message;
    statusEl.textContent = "Ready";
    setBusy(false);
    await chrome.storage.local.set({
      sunoCaptureState: { status: "idle", failedAt: Date.now() },
      sunoCaptureError: message,
    });
    try {
      await chrome.runtime.sendMessage({ target: "background", type: "endSession" });
    } catch (_) {
      /* ignore */
    }
  }
}

async function beginLyricsAndCovers() {
  errorEl.textContent = "";
  statusEl.textContent = "Reading lyrics and covers…";
  setBusy(true);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error("Couldn't find the active tab.");
    const parsed = parseSunoTabUrl(tab.url || "");
    if (!parsed || !isSunoLibraryPath(parsed.pathname)) {
      throw new Error("Open suno.com/me, then click Lyrics and covers.");
    }
    await chrome.storage.local.remove(["sunoCaptureError", "sunoCaptureLastLog"]);
    await chrome.storage.local.set({
      sunoCaptureState: { status: "idle", resetAt: Date.now() },
    });
    try {
      await chrome.runtime.sendMessage({ target: "background", type: "endSession" });
    } catch (_) {
      /* no audio session to close */
    }
    await ensureContentScript(tab.id);
    await chrome.storage.local.set({
      sunoCaptureState: {
        status: "collecting",
        queue: [],
        currentIndex: 0,
        startedAt: Date.now(),
        mode: "meta",
      },
    });
    statusEl.textContent = "Reading lyrics and covers…";
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    errorEl.textContent = message;
    statusEl.textContent = "Ready";
    setBusy(false);
    await chrome.storage.local.set({
      sunoCaptureState: { status: "idle", failedAt: Date.now(), mode: "meta" },
      sunoCaptureError: message,
    });
  }
}

startBtn.addEventListener("click", () => beginSession("library"));
oneSongBtn.addEventListener("click", () => beginSession("one"));
lyricsBtn.addEventListener("click", () => beginLyricsAndCovers());

stopBtn.addEventListener("click", async () => {
  try {
    await chrome.storage.local.set({
      sunoCaptureState: { status: "idle", stoppedAt: Date.now() },
    });
    await chrome.runtime.sendMessage({ target: "background", type: "endSession" });
  } catch (err) {
    errorEl.textContent = err && err.message ? err.message : String(err);
  }
  await refresh();
});

optionsLink.addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") refresh();
});

refresh();
