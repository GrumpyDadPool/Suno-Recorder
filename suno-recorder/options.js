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
const recordedFilterEl = document.getElementById("recordedFilter");
const recordedListEl = document.getElementById("recordedList");
const recordedEmptyEl = document.getElementById("recordedEmpty");
const recordedClearBtn = document.getElementById("recordedClearBtn");

let recordedTitles = [];

function renderScanned(count) {
  if (count > 0) {
    scanMsg.textContent = `${count} file${count === 1 ? "" : "s"} scanned for skip-done.`;
    scanClearBtn.hidden = false;
  } else {
    scanMsg.textContent = "";
    scanClearBtn.hidden = true;
  }
}

function renderRecorded() {
  const query = (recordedFilterEl.value || "").trim().toLowerCase();
  const shown = recordedTitles
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title))
    .filter((item) => !query || item.title.toLowerCase().includes(query));

  recordedListEl.replaceChildren();
  recordedClearBtn.hidden = recordedTitles.length === 0;

  if (!recordedTitles.length) {
    recordedEmptyEl.textContent = "No songs recorded yet.";
    return;
  }
  recordedEmptyEl.textContent = shown.length ? `${recordedTitles.length} recorded.` : "No titles match that filter.";

  for (const item of shown) {
    const row = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = item.title;
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "linkish";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", async () => {
      await forgetRecordedTitle(item.title);
      await refreshRecorded();
    });
    row.append(name, removeBtn);
    recordedListEl.append(row);
  }
}

async function refreshRecorded() {
  const state = await loadRecordedState();
  recordedTitles = (state.titles || [])
    .map((entry) => normalizeRecordedEntry(entry))
    .filter(Boolean);
  renderRecorded();
}

async function load() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  maxTracksEl.value = stored.maxTracks ?? 0;
  filenamePrefixEl.value = stored.filenamePrefix || "";
  saveFolderEl.value = stored.saveFolder || "";
  skipCapturedEl.checked = stored.skipCaptured !== false;
  monitorAudioEl.checked = Boolean(stored.monitorAudio);

  // Scan storage is only the last scan's count. Names were merged when the
  // user chose the folder; do not seed from download history or merge again.
  const scan = await chrome.storage.local.get("sunoCaptureScannedTitles");
  const scanned = scan.sunoCaptureScannedTitles || [];
  renderScanned(scanned.length);
  await refreshRecorded();
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

async function persistScanned(titles) {
  await chrome.storage.local.set({
    sunoCaptureScannedTitles: titles,
    sunoCaptureScannedAt: Date.now(),
  });
  renderScanned(titles.length);
  // This explicit scan is the only merge. A removed title returns if the
  // folder still has it. Opening Options later does not merge this list again.
  const prefix = (filenamePrefixEl.value || "").trim();
  await mergeIncomingRecordedTitles(
    titles.map((name) => titleFromCapturedName(name, prefix)).filter(Boolean),
    { overrideDismissed: true }
  );
  await refreshRecorded();
}

async function collectAudioNames(dirHandle, out, depth) {
  if (depth > 6) return;
  for await (const entry of dirHandle.values()) {
    if (entry.kind === "file") {
      if (AUDIO_EXT_RE.test(entry.name)) out.push(entry.name.replace(AUDIO_EXT_RE, ""));
    } else if (entry.kind === "directory") {
      await collectAudioNames(entry, out, depth + 1);
    }
  }
}

scanBtn.addEventListener("click", async () => {
  // Prefer the File System Access picker: it shows a normal "choose folder /
  // view files" dialog instead of the <input webkitdirectory> "Upload N files
  // to this site?" prompt. Nothing is uploaded either way — we only read the
  // file names locally to know what's already been captured.
  if (typeof window.showDirectoryPicker === "function") {
    let dirHandle;
    try {
      dirHandle = await window.showDirectoryPicker({ mode: "read" });
    } catch (err) {
      if (err && err.name === "AbortError") return; // user cancelled the picker
      scanMsg.textContent = "Couldn't open that folder.";
      return;
    }
    try {
      const titles = [];
      await collectAudioNames(dirHandle, titles, 0);
      await persistScanned(titles);
    } catch (_) {
      scanMsg.textContent = "Couldn't read that folder.";
    }
    return;
  }
  // Fallback for browsers without the File System Access API.
  scanFolderEl.click();
});

scanFolderEl.addEventListener("change", async () => {
  const files = Array.from(scanFolderEl.files || []);
  const titles = files
    .map((file) => file.name)
    .filter((name) => AUDIO_EXT_RE.test(name))
    .map((name) => name.replace(AUDIO_EXT_RE, ""));
  await persistScanned(titles);
  // Reset so re-picking the same folder still fires a change event.
  scanFolderEl.value = "";
});

scanClearBtn.addEventListener("click", async () => {
  // Clears the scan count only. Recorded songs stay as they are.
  await chrome.storage.local.remove(["sunoCaptureScannedTitles", "sunoCaptureScannedAt"]);
  renderScanned(0);
});

recordedFilterEl.addEventListener("input", () => {
  renderRecorded();
});

recordedClearBtn.addEventListener("click", async () => {
  await clearRecordedTitles();
  await refreshRecorded();
});

load();
