// Holds the tab's audio MediaStream for the life of the capture session, and
// creates/tears down one MediaRecorder per track so each track lands as its
// own clean file.
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
    case "hasStream":
      return { ok: true, hasStream: Boolean(persistentStream) };
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
  if (!audioTrack) {
    throw new Error("Tab capture stream has no audio track");
  }
  audioTrack.onended = () => {
    reportError(
      "The captured audio stream ended unexpectedly mid-track. If a track comes out " +
        "shorter than expected or empty, this is why."
    );
  };

  // Optional speaker monitor — off by default so capture stays silent.
  // Note: Chrome routes tab audio into the capture stream; without a monitor
  // you won't hear playback, but MediaRecorder still receives the samples.
  if (monitorAudio) {
    monitorContext = new AudioContext();
    monitorSource = monitorContext.createMediaStreamSource(persistentStream);
    monitorSource.connect(monitorContext.destination);
    if (monitorContext.state === "suspended") {
      await monitorContext.resume();
    }
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
    throw new Error("startRecording called before initStream — capture stream is gone. Click Start recording again.");
  }
  const track = persistentStream.getAudioTracks()[0];
  if (!track || track.readyState !== "live") {
    throw new Error("Tab audio track is not live — click Start recording again on the Suno tab.");
  }

  if (currentRecorder && currentRecorder.state !== "inactive") {
    try {
      currentRecorder.onstop = null;
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

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
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
        // Make sure we flush the final chunk.
        if (recorder.state === "inactive" && currentChunks.length === 0) {
          // no-op
        }
        const mimeType = recorder.mimeType || "audio/webm";
        const blob = new Blob(currentChunks, { type: mimeType });
        if (!blob.size) {
          throw new Error(
            `Recording for "${filename}" was empty (0 bytes). ` +
              "Usually means playback never reached the tab-capture stream — try Options → enable speaker monitor once to verify audio."
          );
        }

        let response;
        try {
          const buffer = await blob.arrayBuffer();
          response = await chrome.runtime.sendMessage({
            target: "background",
            type: "saveRecording",
            filename,
            mimeType,
            buffer,
          });
        } catch (bufferErr) {
          // Fallback for environments that choke on large ArrayBuffer messages.
          const dataUrl = await blobToDataUrl(blob);
          response = await chrome.runtime.sendMessage({
            target: "background",
            type: "saveRecording",
            filename,
            mimeType,
            dataUrl,
          });
        }

        if (!response || !response.ok) {
          // One more attempt via data URL if buffer path reported failure.
          if (!response || /buffer|clone|message/i.test(String(response && response.error))) {
            const dataUrl = await blobToDataUrl(blob);
            response = await chrome.runtime.sendMessage({
              target: "background",
              type: "saveRecording",
              filename,
              mimeType,
              dataUrl,
            });
          }
        }

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
    try {
      if (recorder.state === "recording") recorder.requestData();
    } catch (_) {
      /* ignore */
    }
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
