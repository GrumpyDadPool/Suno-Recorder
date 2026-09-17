// MV3 service workers can be killed and restarted by Chrome at any time —
// they can't hold long-lived state in plain JS variables across a multi-
// minute capture session. Everything that needs to survive that goes into
// chrome.storage.local, and this file re-reads it on every event rather than
// assuming its own memory is still valid.
//
// tabCapture's actual media stream can only be consumed in a context with a
// DOM (a service worker can't call getUserMedia) — that's what the offscreen
// document (offscreen.html/offscreen.js) is for.
//
// IMPORTANT — every message includes a `target` field ("background" or
// "offscreen"), and every listener bails out immediately for messages not
// addressed to it.
//
// IMPORTANT — the capture stream is acquired ONCE when "Start recording" is
// clicked (fresh user gesture). Do not recreate an empty offscreen document
// mid-session without re-initing the stream.

const OFFSCREEN_URL = "offscreen.html";
const KEEPALIVE_ALARM = "suno-recorder-keepalive";

async function offscreenDocumentExists() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return existing.length > 0;
}

async function closeOffscreenDocumentIfExists() {
  if (await offscreenDocumentExists()) {
    await chrome.offscreen.closeDocument();
  }
}

async function ensureOffscreenDocument() {
  if (await offscreenDocumentExists()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA", "BLOBS"],
    justification: "Records Suno tab audio during playback capture and stages download blobs.",
  });
}

async function startKeepalive() {
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
}

async function stopKeepalive() {
  await chrome.alarms.clear(KEEPALIVE_ALARM);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    chrome.storage.local.set({ sunoCaptureHeartbeat: Date.now() });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "background") return false;
  handleMessage(message, sender).then(sendResponse).catch((err) => {
    console.error("Suno Recorder background error:", err);
    sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
  });
  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case "startSession": {
      const tabId = message.tabId;
      if (!tabId) {
        throw new Error("startSession message had no tabId — can't capture");
      }
      await closeOffscreenDocumentIfExists();
      let streamId;
      try {
        streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      } catch (err) {
        throw new Error(
          `Tab audio permission failed: ${err && err.message ? err.message : err}. ` +
            "Click the extension icon on a suno.com tab and try again."
        );
      }
      await ensureOffscreenDocument();
      const options = await getOptions();
      const init = await sendToOffscreenWithRetry({
        target: "offscreen",
        type: "initStream",
        streamId,
        monitorAudio: Boolean(options.monitorAudio),
      });
      if (!init || !init.ok) {
        throw new Error(init && init.error ? init.error : "Failed to initialize tab audio capture");
      }
      await startKeepalive();
      return { ok: true };
    }

    case "startRecording": {
      if (!(await offscreenDocumentExists())) {
        throw new Error(
          "Capture stream was lost (offscreen page closed). Click Stop, then Start recording again."
        );
      }
      const probe = await chrome.runtime.sendMessage({ target: "offscreen", type: "hasStream" });
      if (!probe || !probe.hasStream) {
        throw new Error(
          "Capture stream was lost. Click Stop, then Start recording again from the Suno tab."
        );
      }
      const response = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "startRecording",
        title: message.title,
      });
      if (!response || !response.ok) {
        throw new Error(response && response.error ? response.error : "startRecording failed");
      }
      return { ok: true };
    }

    case "stopRecordingAndSave": {
      const response = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "stopRecordingAndSave",
        filename: message.filename,
      });
      if (!response || !response.ok) {
        throw new Error(response && response.error ? response.error : "save failed");
      }
      return { ok: true, extension: response.extension || "wav" };
    }

    case "discardRecording": {
      if (await offscreenDocumentExists()) {
        await chrome.runtime.sendMessage({ target: "offscreen", type: "discardRecording" });
      }
      return { ok: true };
    }

    case "saveRecording": {
      let url = message.dataUrl || null;
      let objectUrl = null;

      if (!url && message.buffer) {
        const bytes = coerceToUint8Array(message.buffer);
        if (!bytes || !bytes.byteLength) {
          throw new Error("saveRecording received an empty audio buffer");
        }
        const blob = new Blob([bytes], { type: message.mimeType || "audio/wav" });
        objectUrl = URL.createObjectURL(blob);
        url = objectUrl;
      }

      if (!url) {
        throw new Error("saveRecording had no audio payload");
      }

      const extension = (message.extension || "wav").replace(/^\./, "");
      try {
        const downloadId = await chrome.downloads.download({
          url,
          filename: `${message.filename}.${extension}`,
          saveAs: false,
          conflictAction: "uniquify",
        });
        if (downloadId === undefined) {
          throw new Error("chrome.downloads.download returned no id");
        }
        await waitForDownloadSettle(downloadId, 45_000);
      } finally {
        if (objectUrl) {
          setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
        }
      }
      return { ok: true, extension };
    }

    case "reportError": {
      await chrome.storage.local.set({
        sunoCaptureError: message.message,
        sunoCaptureErrorAt: Date.now(),
      });
      return { ok: true };
    }

    case "endSession": {
      await stopKeepalive();
      await closeOffscreenDocumentIfExists();
      return { ok: true };
    }

    case "getOptions": {
      return { ok: true, options: await getOptions() };
    }

    default: {
      return { ok: false, error: `Unknown message type: ${message.type}` };
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForDownloadSettle(downloadId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      cleanup();
      // Still resolve — Chrome may finish after our wait; don't fail a good capture.
      resolve({ timedOut: true });
    }, timeoutMs);

    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state && delta.state.current === "complete") {
        cleanup();
        resolve({ complete: true });
      } else if (delta.state && delta.state.current === "interrupted") {
        cleanup();
        reject(new Error(`Download interrupted for id ${downloadId}`));
      } else if (delta.error && delta.error.current) {
        cleanup();
        reject(new Error(`Download error: ${delta.error.current}`));
      }
    };

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
    };

    chrome.downloads.onChanged.addListener(onChanged);
    // In case it completed before the listener attached.
    chrome.downloads.search({ id: downloadId }).then((items) => {
      const item = items && items[0];
      if (!item || settled) return;
      if (item.state === "complete") {
        cleanup();
        resolve({ complete: true });
      } else if (item.state === "interrupted") {
        cleanup();
        reject(new Error(`Download interrupted for id ${downloadId}`));
      }
    });
  });
}

async function sendToOffscreenWithRetry(message, attempts = 8) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    if (!(await offscreenDocumentExists())) {
      await ensureOffscreenDocument();
    }
    await delay(50 + i * 40);
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (response) return response;
      lastError = new Error("No response from offscreen document");
    } catch (err) {
      lastError = err;
      // Receiving end missing — document still booting.
    }
  }
  throw new Error(
    lastError && lastError.message
      ? lastError.message
      : "Could not reach the offscreen audio recorder"
  );
}

function coerceToUint8Array(buffer) {
  if (!buffer) return null;
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (ArrayBuffer.isView(buffer)) {
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  if (typeof buffer === "object") {
    // Rare structured-clone oddity: plain object with numeric keys.
    const keys = Object.keys(buffer);
    if (keys.length && keys.every((k) => /^\d+$/.test(k))) {
      const arr = new Uint8Array(keys.length);
      for (const k of keys) arr[Number(k)] = buffer[k] & 0xff;
      return arr;
    }
  }
  return null;
}

async function getOptions() {
  const local = await chrome.storage.local.get("sunoCaptureOptions");
  if (local.sunoCaptureOptions) return local.sunoCaptureOptions;
  const sync = await chrome.storage.sync.get({
    maxTracks: 0,
    filenamePrefix: "",
    skipCaptured: true,
    monitorAudio: true,
  });
  return sync;
}
