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
// doesn't call sendResponse) for messages not addressed to it. Without this,
// chrome.runtime.sendMessage() broadcasts to *every* listening context in
// the extension — once the offscreen document exists, it also receives
// messages meant only for background.js (and vice versa), and whichever
// listener responds first wins, even if it's the wrong one. That was
// previously producing a real bug: the offscreen document answering a
// "startSession" message it didn't recognize with a bare {ok:false} before
// background.js's real (slightly slower, async) handler could respond,
// surfacing as "Couldn't start capture: undefined" in the popup.
//
// IMPORTANT — the capture stream is acquired ONCE, right when "Start
// Capture" is clicked, not per track. This used to acquire a fresh stream
// per track defensively (to guard against navigation breaking it), but
// since capture now stays on suno.com/me for the whole session and never
// navigates away, that defense is no longer needed — and it actively broke
// things: chrome.tabCapture.getMediaStreamId() requires a *fresh* user
// gesture on the target tab, and by the time the first track was ready to
// record (after scrolling to load the whole library), that gesture had
// gone stale, causing "Extension has not been invoked for the current page
// (see activeTab permission)". Acquiring immediately in response to the
// popup click — the one moment guaranteed to count as a fresh gesture —
// fixes this.

const OFFSCREEN_URL = "offscreen.html";

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
    reasons: ["USER_MEDIA"],
    justification: "Records Suno tab audio during playback capture.",
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "background") return false; // not for us
  handleMessage(message, sender).then(sendResponse).catch((err) => {
    console.error("Suno Capture background error:", err);
    sendResponse({ ok: false, error: String(err) });
  });
  return true; // keep the message channel open for the async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case "startSession": {
      const tabId = message.tabId;
      if (!tabId) {
        throw new Error("startSession message had no tabId — can't capture");
      }
      // Clean slate first: a stale offscreen document from a previous
      // attempt (interrupted, crashed, or just never stopped) holds an
      // active tab-capture stream, and Chrome refuses to capture the same
      // tab twice — that's the "Cannot capture a tab with an active
      // stream" error. Closing first prevents that.
      await closeOffscreenDocumentIfExists();
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      await ensureOffscreenDocument();
      await chrome.runtime.sendMessage({ target: "offscreen", type: "initStream", streamId });
      return { ok: true };
    }

    case "startRecording": {
      await ensureOffscreenDocument();
      await chrome.runtime.sendMessage({ target: "offscreen", type: "startRecording", title: message.title });
      return { ok: true };
    }

    case "stopRecordingAndSave": {
      await chrome.runtime.sendMessage({ target: "offscreen", type: "stopRecordingAndSave", filename: message.filename });
      return { ok: true };
    }

    case "discardRecording": {
      await chrome.runtime.sendMessage({ target: "offscreen", type: "discardRecording" });
      return { ok: true };
    }

    case "saveRecording": {
      // Relayed from offscreen.js, which can't call chrome.downloads directly
      // (restricted API access in that context — see the note in offscreen.js).
      // No subfolder prefix: files land wherever Chrome's own default download
      // location is set. Point that at wherever you want captures to end up
      // (chrome://settings/downloads) rather than this code choosing a path —
      // extensions can't write outside the Downloads directory regardless.
      await chrome.downloads.download({
        url: message.dataUrl,
        filename: `${message.filename}.webm`,
        saveAs: false,
      });
      return { ok: true };
    }

    case "reportError": {
      // Relayed from offscreen.js, which can't reliably use chrome.storage
      // directly in that context either.
      await chrome.storage.local.set({ sunoCaptureError: message.message, sunoCaptureErrorAt: Date.now() });
      return { ok: true };
    }

    case "endSession": {
      await closeOffscreenDocumentIfExists();
      return { ok: true };
    }

    default:
      return { ok: false, error: `Unknown message type: ${message.type}` };
  }
}
