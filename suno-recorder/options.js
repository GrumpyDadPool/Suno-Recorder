const DEFAULTS = {
  maxTracks: 0,
  filenamePrefix: "",
  skipCaptured: true,
  monitorAudio: true,
  downloadSubdir: "Suno Recorder",
};

const maxTracksEl = document.getElementById("maxTracks");
const filenamePrefixEl = document.getElementById("filenamePrefix");
const downloadSubdirEl = document.getElementById("downloadSubdir");
const skipCapturedEl = document.getElementById("skipCaptured");
const monitorAudioEl = document.getElementById("monitorAudio");
const saveBtn = document.getElementById("saveBtn");
const saveMsg = document.getElementById("saveMsg");
const scanFolderBtn = document.getElementById("scanFolderBtn");
const scanFolderStatus = document.getElementById("scanFolderStatus");

function sanitizeDownloadSubdir(raw) {
  let s = String(raw == null ? "" : raw).trim().replace(/\\/g, "/");
  s = s.replace(/^\/+/, "");
  s = s
    .split("/")
    .map((part) => part.replace(/\.\./g, "").replace(/[^\w\- .]/g, "").trim())
    .filter(Boolean)
    .join("/");
  return (s || "Suno Recorder").slice(0, 80);
}

function basenameKey(filename) {
  const leaf = String(filename || "").replace(/\\/g, "/").split("/").pop() || "";
  return leaf.replace(/\.(wav|webm|mp3)$/i, "").toLowerCase();
}

async function load() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  const local = await chrome.storage.local.get(["sunoCaptureOptions", "sunoCapturedBasenames", "sunoScanFolderName"]);
  const opts = { ...DEFAULTS, ...stored, ...(local.sunoCaptureOptions || {}) };
  maxTracksEl.value = opts.maxTracks ?? 0;
  filenamePrefixEl.value = opts.filenamePrefix || "";
  downloadSubdirEl.value = opts.downloadSubdir || "Suno Recorder";
  skipCapturedEl.checked = opts.skipCaptured !== false;
  monitorAudioEl.checked = Boolean(opts.monitorAudio);

  const count = Array.isArray(local.sunoCapturedBasenames) ? local.sunoCapturedBasenames.length : 0;
  const folder = local.sunoScanFolderName || "";
  if (folder || count) {
    scanFolderStatus.textContent = folder
      ? `Last scan: “${folder}” · ${count} name(s) indexed for skip-done.`
      : `${count} name(s) indexed for skip-done.`;
  }
}

async function persistOptions() {
  const maxTracks = Math.max(0, Number.parseInt(maxTracksEl.value || "0", 10) || 0);
  const filenamePrefix = (filenamePrefixEl.value || "").trim().slice(0, 40);
  const downloadSubdir = sanitizeDownloadSubdir(downloadSubdirEl.value);
  downloadSubdirEl.value = downloadSubdir;
  const payload = {
    maxTracks,
    filenamePrefix,
    downloadSubdir,
    skipCaptured: skipCapturedEl.checked,
    monitorAudio: monitorAudioEl.checked,
  };
  await chrome.storage.sync.set(payload);
  await chrome.storage.local.set({ sunoCaptureOptions: payload });
  return payload;
}

saveBtn.addEventListener("click", async () => {
  await persistOptions();
  saveMsg.textContent = "Saved.";
  setTimeout(() => {
    saveMsg.textContent = "";
  }, 1600);
});

scanFolderBtn.addEventListener("click", async () => {
  if (typeof showDirectoryPicker !== "function") {
    scanFolderStatus.textContent =
      "File System Access is not available in this Chrome build. Skip-done still uses Downloads history.";
    return;
  }

  scanFolderStatus.textContent = "Pick a folder…";
  try {
    const dir = await showDirectoryPicker({ mode: "read" });
    const names = [];
    for await (const entry of dir.values()) {
      if (entry.kind !== "file") continue;
      if (!/\.(wav|webm|mp3)$/i.test(entry.name)) continue;
      const key = basenameKey(entry.name);
      if (key) names.push(key);
    }

    const stored = await chrome.storage.local.get("sunoCapturedBasenames");
    const merged = new Map();
    for (const name of stored.sunoCapturedBasenames || []) {
      merged.set(String(name).toLowerCase(), String(name));
    }
    for (const name of names) {
      merged.set(name.toLowerCase(), name);
    }
    const list = Array.from(merged.values());
    while (list.length > 20000) list.shift();

    await chrome.storage.local.set({
      sunoCapturedBasenames: list,
      sunoScanFolderName: dir.name,
    });
    // Keep save-folder option in sync if the user scanned a similarly named dir.
    if (!downloadSubdirEl.value.trim()) {
      downloadSubdirEl.value = sanitizeDownloadSubdir(dir.name);
    }
    await persistOptions();
    scanFolderStatus.textContent = `Indexed ${names.length} audio file(s) from “${dir.name}” (${list.length} total for skip-done). Saves still go to Downloads/${sanitizeDownloadSubdir(downloadSubdirEl.value)}/.`;
  } catch (err) {
    if (err && err.name === "AbortError") {
      scanFolderStatus.textContent = "Folder scan cancelled.";
      return;
    }
    scanFolderStatus.textContent = `Folder scan failed: ${err && err.message ? err.message : err}`;
  }
});

load();
