const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const errorEl = document.getElementById("error");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");

function render(state, error, lastLog) {
  if (!state || state.status === "idle") {
    const finished = state && state.finishedAt;
    if (finished && state.queue) {
      const done = state.queue.filter((t) => t.done && !t.failed).length;
      const failed = state.queue.filter((t) => t.failed).length;
      statusEl.textContent = `Done. ${done} captured${failed ? `, ${failed} failed` : ""} out of ${state.queue.length}.`;
    } else {
      statusEl.textContent = "Idle.";
    }
  } else if (state.status === "collecting") {
    statusEl.textContent = "Scanning your library (scrolling to load everything)...";
  } else if (state.status === "capturing") {
    const done = state.queue.filter((t) => t.done).length;
    const current = state.queue[state.currentIndex];
    statusEl.textContent = `Capturing ${done + 1} of ${state.queue.length}: ${current ? current.title : "..."}`;
  }

  logEl.textContent = lastLog || "";
  errorEl.textContent = error ? `! ${error}` : "";
}

async function refresh() {
  const result = await chrome.storage.local.get(["sunoCaptureState", "sunoCaptureError", "sunoCaptureLastLog"]);
  render(result.sunoCaptureState, result.sunoCaptureError, result.sunoCaptureLastLog);
}

startBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes("suno.com")) {
    errorEl.textContent = "! Open suno.com/me in this tab first.";
    return;
  }

  await chrome.storage.local.remove(["sunoCaptureError", "sunoCaptureLastLog"]);
  const response = await chrome.runtime.sendMessage({ target: "background", type: "startSession", tabId: tab.id });
  if (!response || !response.ok) {
    errorEl.textContent = `! Couldn't start capture: ${response ? response.error : "unknown error"}`;
    return;
  }

  await chrome.storage.local.set({
    sunoCaptureState: { status: "collecting", queue: [], currentIndex: 0 },
  });

  // if the tab isn't already on /me, send it there so the content script's
  // storage-change listener has a page to scrape
  if (!tab.url.includes("/me")) {
    await chrome.tabs.update(tab.id, { url: "https://suno.com/me" });
  }
});

stopBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({ sunoCaptureState: { status: "idle" } });
  await chrome.runtime.sendMessage({ target: "background", type: "endSession" });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") refresh();
});

refresh();
