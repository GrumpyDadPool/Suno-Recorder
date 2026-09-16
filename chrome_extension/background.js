// MV3 service workers can be killed and restarted by Chrome at any time —
// they can't hold long-lived state in plain JS variables across a multi-
// minute capture session. Everything that needs to survive that goes into
// chrome.storage.local, and this file re-reads it on every event rather than
// assuming its own memory is still valid.
//
// tabCapture's actual media stream can only be consumed in a context with a
// DOM (a service worker can't call getUserMedia) — that's what the offscreen
// document (offscreen.html/offscreen.js) is for. This file's job is just:
// get a stream id for the target tab, hand it to the offscreen document, and
// relay start/stop recording commands to it.
//
// IMPORTANT — every message includes a `target` field ("background" or
// "offscreen"), and every listener bails out immediately (returns false,
// doesn't call sendResponse) for messages not addressed to it.
//
// IMPORTANT — the capture stream is acquired ONCE, right when "Start
// recording" is clicked, not per track. chrome.tabCapture.getMediaStreamId()
// requires a fresh user gesture; acquiring later (after library scroll)
// fails with the activeTab permission error.

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
  // Chrome may clamp sub-minute periods; 1 minute is enough to keep the worker warm.
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
}

async function stopKeepalive() {
  await chrome.alarms.clear(KEEPALIVE_ALARM);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // Touch storage so the worker stays responsive during long sessions.
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
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      await ensureOffscreenDocument();
      const options = await getOptions();
      await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "initStream",
        streamId,
        monitorAudio: Boolean(options.monitorAudio),
      });
      await startKeepalive();
      return { ok: true };
    }

    case "startRecording": {
      await ensureOffscreenDocument();
      await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "startRecording",
        title: message.title,
      });
      return { ok: true };
    }

    case "stopRecordingAndSave": {
      await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "stopRecordingAndSave",
        filename: message.filename,
      });
      return { ok: true };
    }

    case "discardRecording": {
      await chrome.runtime.sendMessage({ target: "offscreen", type: "discardRecording" });
      return { ok: true };
    }

    case "saveRecording": {
      // Prefer binary payload from offscreen (avoids data-URL size limits on long tracks).
      let url = message.dataUrl;
      let objectUrl = null;
      if (message.buffer) {
        const blob = new Blob([message.buffer], { type: message.mimeType || "audio/webm" });
        objectUrl = URL.createObjectURL(blob);
        url = objectUrl;
      }
      if (!url) {
        throw new Error("saveRecording had no audio payload");
      }
      try {
        await chrome.downloads.download({
          url,
          filename: `${message.filename}.webm`,
          saveAs: false,
        });
      } finally {
        if (objectUrl) {
          // Give Chrome a moment to latch the download before revoking.
          setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
        }
      }
      return { ok: true };
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

async function getOptions() {
  const local = await chrome.storage.local.get("sunoCaptureOptions");
  if (local.sunoCaptureOptions) return local.sunoCaptureOptions;
  const sync = await chrome.storage.sync.get({
    maxTracks: 0,
    filenamePrefix: "",
    skipCaptured: true,
    monitorAudio: false,
  });
  return sync;
}
