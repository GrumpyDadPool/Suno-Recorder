const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const errorEl = document.getElementById("error");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const meterEl = document.getElementById("meter");
const progressWrap = document.getElementById("progressWrap");
const progressBar = document.getElementById("progressBar");
const optionsLink = document.getElementById("optionsLink");

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
    statusEl.textContent = "Starting capture…";
    progressWrap.hidden = false;
    progressBar.style.width = "4%";
  } else if (state.status === "collecting") {
    statusEl.textContent = "Scanning library…";
    progressWrap.hidden = false;
    progressBar.style.width = "8%";
  } else if (state.status === "capturing") {
    const total = state.discoveredTotal || state.queue.length || 0;
    const done = (state.queue || []).filter((t) => t.done).length;
    const current = state.queue && state.queue[state.currentIndex];
    const label = state.currentTitle || (typeof current === "string" ? current : current && current.title);
    statusEl.textContent = total
      ? `Recording ${Math.min(done + 1, total)} / ${total}${label ? ` · ${label}` : ""}`
      : `Recording${label ? ` · ${label}` : ""}`;
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
  if (!state || (state.status !== "collecting" && state.status !== "capturing" && state.status !== "starting")) {
    return;
  }
  const startedAt = state.startedAt || 0;
  const lastBeat = heartbeat || startedAt;
  const age = Date.now() - Math.max(startedAt, lastBeat);
  // If a previous run died mid-session, Start stays disabled forever without this.
  if (age > STALE_SESSION_MS && !(state.queue || []).some((t) => t.done)) {
    await chrome.storage.local.set({
      sunoCaptureState: { status: "idle", resetAt: Date.now(), resetReason: "stale-session" },
      sunoCaptureError: "Previous session looked stuck and was reset. Try Start recording again.",
    });
  }
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
    files: ["title_utils.js", "content.js"],
  });
}

startBtn.addEventListener("click", async () => {
  errorEl.textContent = "";
  statusEl.textContent = "Starting capture…";
  setBusy(true);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      throw new Error("Couldn't find the active tab.");
    }
    const parsed = parseSunoTabUrl(tab.url || "");
    if (!parsed) {
      throw new Error("Open suno.com/me in this tab first, then click Start recording.");
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
      sunoCaptureState: { status: "starting", queue: [], currentIndex: 0, startedAt: Date.now() },
    });

    const response = await withTimeout(
      chrome.runtime.sendMessage({
        target: "background",
        type: "startSession",
        tabId: tab.id,
      }),
      START_TIMEOUT_MS,
      "Timed out starting tab audio capture. Reload the extension, refresh suno.com/me, and try again."
    );

    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "unknown error starting session");
    }

    // Make sure the library scraper is alive (reload extension ≠ refresh page).
    if (isSunoLibraryPath(parsed.pathname)) {
      await ensureContentScript(tab.id);
    }

    await chrome.storage.local.set({
      sunoCaptureState: {
        status: "collecting",
        queue: [],
        currentIndex: 0,
        startedAt: Date.now(),
      },
    });

    if (!isSunoLibraryPath(parsed.pathname)) {
      await chrome.tabs.update(tab.id, { url: "https://suno.com/me" });
    }

    statusEl.textContent = "Scanning library…";
  } catch (err) {
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
});

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
