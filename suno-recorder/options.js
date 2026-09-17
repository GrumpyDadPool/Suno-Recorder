const DEFAULTS = {
  maxTracks: 0,
  filenamePrefix: "",
  skipCaptured: true,
  monitorAudio: true,
};

const maxTracksEl = document.getElementById("maxTracks");
const filenamePrefixEl = document.getElementById("filenamePrefix");
const skipCapturedEl = document.getElementById("skipCaptured");
const monitorAudioEl = document.getElementById("monitorAudio");
const saveBtn = document.getElementById("saveBtn");
const saveMsg = document.getElementById("saveMsg");

async function load() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  maxTracksEl.value = stored.maxTracks ?? 0;
  filenamePrefixEl.value = stored.filenamePrefix || "";
  skipCapturedEl.checked = stored.skipCaptured !== false;
  monitorAudioEl.checked = Boolean(stored.monitorAudio);
}

saveBtn.addEventListener("click", async () => {
  const maxTracks = Math.max(0, Number.parseInt(maxTracksEl.value || "0", 10) || 0);
  const filenamePrefix = (filenamePrefixEl.value || "").trim().slice(0, 40);
  await chrome.storage.sync.set({
    maxTracks,
    filenamePrefix,
    skipCaptured: skipCapturedEl.checked,
    monitorAudio: monitorAudioEl.checked,
  });
  // Keep a local mirror so content/background can read quickly without sync lag.
  await chrome.storage.local.set({
    sunoCaptureOptions: { maxTracks, filenamePrefix, skipCaptured: skipCapturedEl.checked, monitorAudio: monitorAudioEl.checked },
  });
  saveMsg.textContent = "Saved.";
  setTimeout(() => {
    saveMsg.textContent = "";
  }, 1600);
});

load();
