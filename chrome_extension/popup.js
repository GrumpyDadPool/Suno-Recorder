const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const errorEl = document.getElementById("error");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const meterEl = document.getElementById("meter");
const progressWrap = document.getElementById("progressWrap");
const progressBar = document.getElementById("progressBar");
const optionsLink = document.getElementById("optionsLink");

function setBusy(isBusy) {
  startBtn.disabled = isBusy;
  meterEl.classList.toggle("active", isBusy);
}

function render(state, error, lastLog) {
  const busy = state && (state.status === "collecting" || state.status === "capturing");
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
  } else if (state.status === "collecting") {
    statusEl.textContent = "Scanning library…";
    progressWrap.hidden = false;
    progressBar.style.width = "8%";
  } else if (state.status === "capturing") {
    const total = state.queue.length || state.discoveredTotal || 0;
    const done = state.queue.filter((t) => t.done).length;
    const current = state.queue[state.currentIndex] || state.currentTitle;
    const label = typeof current === "string" ? current : current && current.title;
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
  ]);
  render(result.sunoCaptureState, result.sunoCaptureError, result.sunoCaptureLastLog);
}

startBtn.addEventListener("click", async () => {
  errorEl.textContent = "";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes("suno.com")) {
    errorEl.textContent = "Open suno.com/me in this tab first.";
    return;
  }

  await chrome.storage.local.remove(["sunoCaptureError", "sunoCaptureLastLog"]);
  const response = await chrome.runtime.sendMessage({
    target: "background",
    type: "startSession",
    tabId: tab.id,
  });
  if (!response || !response.ok) {
    errorEl.textContent = `Couldn't start: ${response && response.error ? response.error : "unknown error"}`;
    return;
  }

  await chrome.storage.local.set({
    sunoCaptureState: {
      status: "collecting",
      queue: [],
      currentIndex: 0,
      startedAt: Date.now(),
    },
  });

  if (!tab.url.includes("/me")) {
    await chrome.tabs.update(tab.id, { url: "https://suno.com/me" });
  }
});

stopBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({
    sunoCaptureState: { status: "idle", stoppedAt: Date.now() },
  });
  await chrome.runtime.sendMessage({ target: "background", type: "endSession" });
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
