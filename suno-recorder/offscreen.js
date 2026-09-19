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
let iconTickTimer = null;

const ICON_TICK_MS = 180;

// Drive the animated toolbar icon. A service worker can't reliably run a timer,
// but this offscreen document lives for the whole capture session, so it pings
// the background on a steady interval to advance the icon animation. The timer
// dies with the document when the session ends.
function startIconTicks() {
  stopIconTicks();
  iconTickTimer = setInterval(() => {
    chrome.runtime
      .sendMessage({ target: "background", type: "iconTick" })
      .catch(() => {
        /* background asleep/gone — it redraws on the next tick */
      });
  }, ICON_TICK_MS);
}

function stopIconTicks() {
  if (iconTickTimer !== null) {
    clearInterval(iconTickTimer);
    iconTickTimer = null;
  }
}

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
    case "stopRecordingAndSave": {
      const saved = await stopRecordingAndSave(message.filename);
      return { ok: true, extension: (saved && saved.extension) || "wav" };
    }
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
  stopIconTicks();
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

  // Session is live — start pinging the background to animate the toolbar icon.
  startIconTicks();
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
  // No timeslice: encoding the whole track in one pass avoids the periodic
  // per-chunk encode work that competed with playback and caused audible
  // hitches. stopRecordingAndSave() calls requestData() before stop() so the
  // buffered audio is still flushed into currentChunks.
  currentRecorder.start();
}

// MediaRecorder can only emit WebM/Opus (or similar) in Chrome — not WAV/MP3.
// Decode that blob and rewrite as 16-bit PCM WAV so Downloads + the Distributor
// watcher (which only picks up .wav/.mp3) get a normal audio file.
async function convertRecordingToWav(webmBlob) {
  const audioCtx = new AudioContext();
  try {
    const encoded = await webmBlob.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(encoded.slice(0));
    return audioBufferToWavBlob(audioBuffer);
  } finally {
    try {
      await audioCtx.close();
    } catch (_) {
      /* ignore */
    }
  }
}

function audioBufferToWavBlob(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const bitDepth = 16;
  const samples = audioBuffer.length;
  const blockAlign = (numChannels * bitDepth) >> 3;
  const dataSize = samples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset, string) => {
    for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(audioBuffer.getChannelData(ch));

  let offset = 44;
  for (let i = 0; i < samples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}

async function sendSavePayload(filename, blob, mimeType, extension) {
  // Pass a short blob: URL string instead of the audio bytes. A full-length WAV
  // sent as an ArrayBuffer (or base64 dataURL) through runtime.sendMessage blows
  // past Chrome's 64 MiB per-message limit ("Message exceeded maximum allowed
  // size of 64MiB"). background.js downloads straight from this URL, so only a
  // tiny string crosses the message boundary.
  const objectUrl = URL.createObjectURL(blob);
  try {
    const response = await chrome.runtime.sendMessage({
      target: "background",
      type: "saveRecording",
      filename,
      mimeType,
      extension,
      objectUrl,
    });
    if (response && response.ok) return response;
    throw new Error(response && response.error ? response.error : "save failed");
  } finally {
    // background awaits the download settling before replying, so the blob URL
    // has served its purpose and can be released now.
    URL.revokeObjectURL(objectUrl);
  }
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
        const recordedMime = recorder.mimeType || "audio/webm";
        const recordedBlob = new Blob(currentChunks, { type: recordedMime });
        if (!recordedBlob.size) {
          throw new Error(
            `Recording for "${filename}" was empty (0 bytes). ` +
              "Usually means playback never reached the tab-capture stream — try Options → enable speaker monitor once to verify audio."
          );
        }

        let saveBlob = recordedBlob;
        let mimeType = recordedMime;
        let extension = "webm";
        try {
          saveBlob = await convertRecordingToWav(recordedBlob);
          mimeType = "audio/wav";
          extension = "wav";
        } catch (convertErr) {
          console.warn("Suno Recorder: WAV convert failed, falling back to WebM:", convertErr);
          reportError(
            `Couldn't convert "${filename}" to WAV (${convertErr && convertErr.message ? convertErr.message : convertErr}); saved WebM instead.`
          );
        }

        const response = await sendSavePayload(filename, saveBlob, mimeType, extension);
        if (!response || !response.ok) {
          throw new Error(
            response && response.error ? response.error : "background failed to save the recording"
          );
        }
        currentRecorder = null;
        currentChunks = [];
        resolve({ ok: true, extension });
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
