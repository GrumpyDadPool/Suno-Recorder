// Holds the tab's audio MediaStream for the life of the capture session, and
// creates/tears down one MediaRecorder per track so each track lands as its
// own clean file — no post-hoc splitting needed, since we know exactly when
// each track starts and ends from inside the page itself.
//
// IMPORTANT — offscreen documents have restricted access to Chrome extension
// APIs. chrome.downloads and chrome.storage are NOT reliably available here
// (this was a real bug: calling chrome.downloads.download() directly from
// this file threw "Cannot read properties of undefined (reading download)",
// and the fallback error-reporting path — which used chrome.storage — threw
// too, so the failure was silent). Both are now relayed to background.js via
// messaging instead, since background.js (a full service worker) has
// unrestricted access to both. This file should never call chrome.downloads
// or chrome.storage directly again — route everything through a message.
//
// IMPORTANT — every message includes a `target` field, and this listener
// ignores anything not addressed to "offscreen" — see the note at the top
// of background.js for why that matters (without it, this document answers
// messages meant for background.js too, causing a race that previously
// surfaced as an "undefined" error in the popup).
//
// Also IMPORTANT — one thing this hasn't been verified against a real
// capture session: whether the underlying MediaStream keeps delivering
// audio across a full page navigation. A fresh stream is now acquired per
// track specifically because this turned out not to be reliable — see the
// note in background.js. The defensive check below
// (stream.getAudioTracks()[0].onended) stays as a safety net regardless.
//
// Deliberately does NOT reconnect the captured stream back to speakers
// (would need an AudioContext -> destination hookup) — that's what makes
// capture silent. If you want to hear it while it runs, that's addable, but
// it's off by default since it's not needed for capture to work.

let persistentStream = null;
let currentRecorder = null;
let currentChunks = [];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "offscreen") return false; // not for us
  handleMessage(message).then(sendResponse).catch((err) => {
    console.error("Suno Capture offscreen error:", err);
    reportError(String(err));
    sendResponse({ ok: false, error: String(err) });
  });
  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case "initStream":
      await initStream(message.streamId);
      return { ok: true };
    case "startRecording":
      startRecording(message.title);
      return { ok: true };
    case "stopRecordingAndSave":
      await stopRecordingAndSave(message.filename);
      return { ok: true };
    case "discardRecording":
      discardRecording();
      return { ok: true };
    default:
      return { ok: false, error: `Unknown message type: ${message.type}` };
  }
}

async function initStream(streamId) {
  // Defensive: this offscreen document instance should always be freshly
  // created (background.js closes any existing one before starting a new
  // session), but if that ever changes, don't leak an old stream's tracks.
  if (persistentStream) {
    persistentStream.getTracks().forEach((track) => track.stop());
    persistentStream = null;
  }

  persistentStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
  });

  const audioTrack = persistentStream.getAudioTracks()[0];
  if (audioTrack) {
    audioTrack.onended = () => {
      reportError(
        "The captured audio stream ended unexpectedly mid-track. If a track comes out " +
        "shorter than expected or empty, this is why."
      );
    };
  }
}

function startRecording(title) {
  if (!persistentStream) {
    reportError("startRecording called before initStream — session wasn't started correctly.");
    return;
  }
  currentChunks = [];
  currentRecorder = new MediaRecorder(persistentStream, { mimeType: "audio/webm;codecs=opus" });
  currentRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) currentChunks.push(e.data);
  };
  currentRecorder.start();
}

function stopRecordingAndSave(filename) {
  return new Promise((resolve, reject) => {
    if (!currentRecorder) {
      reject(new Error("stopRecordingAndSave called with no active recording"));
      return;
    }
    currentRecorder.onstop = async () => {
      try {
        const blob = new Blob(currentChunks, { type: "audio/webm" });
        const dataUrl = await blobToDataUrl(blob);
        // chrome.downloads isn't available in this context — background.js
        // does the actual save, since it has full API access.
        const response = await chrome.runtime.sendMessage({
          target: "background",
          type: "saveRecording",
          filename,
          dataUrl,
        });
        if (!response || !response.ok) {
          throw new Error(response && response.error ? response.error : "background failed to save the recording");
        }
        resolve();
      } catch (err) {
        reject(err);
      }
    };
    currentRecorder.stop();
  });
}

function discardRecording() {
  // Used when content.js detects the page navigated away from the expected
  // track mid-playback (e.g. Suno's own autoplay-next taking over) — what
  // got recorded can't be trusted to actually be the intended track, so
  // throw it away instead of saving it under the wrong name.
  if (currentRecorder) {
    currentRecorder.onstop = () => {
      currentChunks = [];
      currentRecorder = null;
    };
    currentRecorder.stop();
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

function reportError(message) {
  // chrome.storage isn't reliably available in this context either — relay
  // to background.js the same way. Wrapped defensively: if even messaging
  // fails, fall back to console so the failure is at least visible in
  // offscreen.js's own DevTools rather than vanishing silently.
  chrome.runtime.sendMessage({ target: "background", type: "reportError", message }).catch((err) => {
    console.error("Suno Capture: failed to report error to background:", err, "original error:", message);
  });
}
