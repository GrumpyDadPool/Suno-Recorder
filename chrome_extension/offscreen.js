// Holds the tab's audio MediaStream for the life of the capture session, and
// creates/tears down one MediaRecorder per track so each track lands as its
// own clean file — no post-hoc splitting needed.
//
// Offscreen documents have restricted Chrome API access. Never call
// chrome.downloads or chrome.storage from here — relay through background.js.
//
// Every message includes a `target` field; this listener ignores anything not
// addressed to "offscreen".

let persistentStream = null;
let monitorContext = null;
let monitorSource = null;
let currentRecorder = null;
let currentChunks = [];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "offscreen") return false;
  handleMessage(message).then(sendResponse).catch((err) => {
    console.error("Suno Recorder offscreen error:", err);
    reportError(String(err && err.message ? err.message : err));
    sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
  });
  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case "initStream":
      await initStream(message.streamId, Boolean(message.monitorAudio));
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

function tearDownMonitor() {
  if (monitorSource) {
    try {
      monitorSource.disconnect();
    } catch (_) {
      /* ignore */
    }
    monitorSource = null;
  }
  if (monitorContext) {
    try {
      monitorContext.close();
    } catch (_) {
      /* ignore */
    }
    monitorContext = null;
  }
}

async function initStream(streamId, monitorAudio) {
  if (persistentStream) {
    persistentStream.getTracks().forEach((track) => track.stop());
    persistentStream = null;
  }
  tearDownMonitor();

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

  // Optional speaker monitor — off by default so capture stays silent.
  if (monitorAudio) {
    monitorContext = new AudioContext();
    monitorSource = monitorContext.createMediaStreamSource(persistentStream);
    monitorSource.connect(monitorContext.destination);
  }
}

function pickMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

function startRecording(title) {
  if (!persistentStream) {
    reportError("startRecording called before initStream — session wasn't started correctly.");
    return;
  }
  if (currentRecorder && currentRecorder.state !== "inactive") {
    try {
      currentRecorder.stop();
    } catch (_) {
      /* ignore */
    }
  }
  currentChunks = [];
  const mimeType = pickMimeType();
  currentRecorder = mimeType
    ? new MediaRecorder(persistentStream, { mimeType })
    : new MediaRecorder(persistentStream);
  currentRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) currentChunks.push(e.data);
  };
  currentRecorder.start(1000);
}

function stopRecordingAndSave(filename) {
  return new Promise((resolve, reject) => {
    if (!currentRecorder) {
      reject(new Error("stopRecordingAndSave called with no active recording"));
      return;
    }
    const recorder = currentRecorder;
    recorder.onstop = async () => {
      try {
        const mimeType = recorder.mimeType || "audio/webm";
        const blob = new Blob(currentChunks, { type: mimeType });
        if (!blob.size) {
          throw new Error(`Recording for "${filename}" was empty (0 bytes)`);
        }
        const buffer = await blob.arrayBuffer();
        const response = await chrome.runtime.sendMessage({
          target: "background",
          type: "saveRecording",
          filename,
          mimeType,
          buffer,
        });
        if (!response || !response.ok) {
          throw new Error(
            response && response.error ? response.error : "background failed to save the recording"
          );
        }
        currentRecorder = null;
        currentChunks = [];
        resolve();
      } catch (err) {
        reject(err);
      }
    };
    recorder.stop();
  });
}

function discardRecording() {
  if (currentRecorder) {
    currentRecorder.onstop = () => {
      currentChunks = [];
      currentRecorder = null;
    };
    try {
      if (currentRecorder.state !== "inactive") currentRecorder.stop();
    } catch (_) {
      currentChunks = [];
      currentRecorder = null;
    }
  }
}

function reportError(message) {
  chrome.runtime.sendMessage({ target: "background", type: "reportError", message }).catch((err) => {
    console.error("Suno Recorder: failed to report error to background:", err, "original error:", message);
  });
}
