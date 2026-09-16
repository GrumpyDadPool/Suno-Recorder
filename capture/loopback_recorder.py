"""
Records whatever your default speakers are actually outputting — this is a
loopback capture, the digital equivalent of recording what comes out of a
speaker. It never touches Suno's stream or its encryption; it only captures
the legitimate audio your own browser has already been allowed to decrypt and
play. That distinction matters: this approach doesn't circumvent anything,
it just records sound your computer is already producing.

LoopbackRecorder keeps one audio stream open for the whole capture session
(cheaper than reopening it per track) but exposes begin_track()/end_track()
so the orchestrator can record each track as its own separate file directly —
mirroring the Chrome extension's design (one persistent MediaStream, a new
MediaRecorder per track). That means no post-hoc silence-detection splitting
is needed for the primary capture flow anymore; segment_splitter.py is kept
in the project for reference/fallback but isn't used by default now.

Windows-only (WASAPI loopback via pyaudiowpatch, a fork of PyAudio that adds
this capability — vanilla PyAudio can't do it). Requires actual audio
hardware to test, so this hasn't been run in the dev sandbox this was built
in — no audio device there. Test it on your machine with a short capture
before running a full library pass.
"""
import threading
import wave
from pathlib import Path


class LoopbackRecorder:
    def __init__(self, log=print):
        self.log = log
        self._pa = None
        self._stream = None
        self._thread = None
        self._stop_event = threading.Event()
        self._lock = threading.Lock()
        self._current_chunks = None  # None = between tracks, not currently recording
        self._channels = None
        self._samplerate = None
        self._sampwidth = None

    def start(self):
        """Opens the loopback device and starts continuously reading from it
        in the background. Call once per capture session."""
        import pyaudiowpatch as pyaudio  # imported here so this module can at least be
                                           # imported/inspected on non-Windows dev machines

        self._pa = pyaudio.PyAudio()
        wasapi_info = self._pa.get_host_api_info_by_type(pyaudio.paWASAPI)
        default_speakers = self._pa.get_device_info_by_index(wasapi_info["defaultOutputDevice"])

        if not default_speakers.get("isLoopbackDevice"):
            found = None
            for loopback in self._pa.get_loopback_device_info_generator():
                if default_speakers["name"] in loopback["name"]:
                    found = loopback
                    break
            if found is None:
                raise RuntimeError(
                    "Couldn't find a loopback device matching your default speakers. "
                    "Make sure 'Stereo Mix' or WASAPI loopback isn't disabled in Windows sound settings."
                )
            default_speakers = found

        self._channels = default_speakers["maxInputChannels"]
        self._samplerate = int(default_speakers["defaultSampleRate"])
        self._sampwidth = self._pa.get_sample_size(pyaudio.paInt16)

        self.log(f"Recording loopback from: {default_speakers['name']} ({self._samplerate}Hz, {self._channels}ch)")

        self._stream = self._pa.open(
            format=pyaudio.paInt16,
            channels=self._channels,
            rate=self._samplerate,
            frames_per_buffer=1024,
            input=True,
            input_device_index=default_speakers["index"],
        )
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._read_loop, daemon=True)
        self._thread.start()

    def _read_loop(self):
        while not self._stop_event.is_set():
            try:
                data = self._stream.read(1024, exception_on_overflow=False)
            except Exception:
                continue
            with self._lock:
                if self._current_chunks is not None:
                    self._current_chunks.append(data)

    def begin_track(self):
        """Starts collecting audio into a fresh buffer. Audio read before
        this call (e.g. while a page is loading) is discarded, same as the
        extension only recording once startRecording has been sent."""
        with self._lock:
            self._current_chunks = []

    def end_track(self, output_path: Path) -> Path:
        """Stops collecting and writes everything captured since begin_track()
        to output_path as its own WAV file."""
        with self._lock:
            chunks = self._current_chunks or []
            self._current_chunks = None

        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(output_path), "wb") as wf:
            wf.setnchannels(self._channels)
            wf.setsampwidth(self._sampwidth)
            wf.setframerate(self._samplerate)
            wf.writeframes(b"".join(chunks))
        return output_path

    def stop(self):
        """Closes everything down. Call once at the end of the capture session."""
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5)
        if self._stream:
            try:
                self._stream.stop_stream()
                self._stream.close()
            except Exception:
                pass
        if self._pa:
            self._pa.terminate()
