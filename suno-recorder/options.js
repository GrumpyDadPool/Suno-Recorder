const DEFAULTS = {
  maxTracks: 0,
  filenamePrefix: "",
  skipCaptured: true,
  monitorAudio: true,
  saveFolder: "Suno Recorder",
};

const AUDIO_EXT_RE = /\.(wav|webm|ogg|mp3|m4a)$/i;

const maxTracksEl = document.getElementById("maxTracks");
const filenamePrefixEl = document.getElementById("filenamePrefix");
const saveFolderEl = document.getElementById("saveFolder");
const skipCapturedEl = document.getElementById("skipCaptured");
const monitorAudioEl = document.getElementById("monitorAudio");
const saveBtn = document.getElementById("saveBtn");
const saveMsg = document.getElementById("saveMsg");
const scanBtn = document.getElementById("scanBtn");
const scanClearBtn = document.getElementById("scanClearBtn");
const scanFolderEl = document.getElementById("scanFolder");
const scanMsg = document.getElementById("scanMsg");

function renderScanned(count) {
  if (count > 0) {
    scanMsg.textContent = `${count} file${count === 1 ? "" : "s"} scanned for skip-done.`;
    scanClearBtn.hidden = false;
  } else {
    scanMsg.textContent = "";
    scanClearBtn.hidden = true;
  }
}

async function load() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  maxTracksEl.value = stored.maxTracks ?? 0;
  filenamePrefixEl.value = stored.filenamePrefix || "";
  saveFolderEl.value = stored.saveFolder || "";
  skipCapturedEl.checked = stored.skipCaptured !== false;
  monitorAudioEl.checked = Boolean(stored.monitorAudio);

  const scan = await chrome.storage.local.get("sunoCaptureScannedTitles");
  renderScanned((scan.sunoCaptureScannedTitles || []).length);
}

saveBtn.addEventListener("click", async () => {
  const maxTracks = Math.max(0, Number.parseInt(maxTracksEl.value || "0", 10) || 0);
  const filenamePrefix = (filenamePrefixEl.value || "").trim().slice(0, 40);
  const saveFolder = (saveFolderEl.value || "").trim().slice(0, 120) || DEFAULTS.saveFolder;
  const options = {
    maxTracks,
    filenamePrefix,
    saveFolder,
    skipCaptured: skipCapturedEl.checked,
    monitorAudio: monitorAudioEl.checked,
  };
  await chrome.storage.sync.set(options);
  // Keep a local mirror so content/background can read quickly without sync lag.
  await chrome.storage.local.set({ sunoCaptureOptions: options });
  saveMsg.textContent = "Saved.";
  setTimeout(() => {
    saveMsg.textContent = "";
  }, 1600);
});

scanBtn.addEventListener("click", () => scanFolderEl.click());

scanFolderEl.addEventListener("change", async () => {
  const files = Array.from(scanFolderEl.files || []);
  const titles = files
    .map((file) => file.name)
    .filter((name) => AUDIO_EXT_RE.test(name))
    .map((name) => name.replace(AUDIO_EXT_RE, ""));
  await chrome.storage.local.set({
    sunoCaptureScannedTitles: titles,
    sunoCaptureScannedAt: Date.now(),
  });
  renderScanned(titles.length);
  // Reset so re-picking the same folder still fires a change event.
  scanFolderEl.value = "";
});

scanClearBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove(["sunoCaptureScannedTitles", "sunoCaptureScannedAt"]);
  renderScanned(0);
});

load();
