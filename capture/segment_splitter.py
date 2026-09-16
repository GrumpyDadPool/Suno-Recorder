"""
NOTE: no longer used by the default capture flow (orchestrator.py now records
each track as its own file directly, via LoopbackRecorder.begin_track()/
end_track(), so there's nothing left to split). Kept in the project as a
reference/fallback in case a future capture method needs to work from one
continuous recording again.

Takes one continuous WAV recording of a whole play-through session and splits
it into individual tracks. Uses silence detection rather than relying purely
on the browser automation's timing estimates — if a track's reported duration
is slightly off, or playback lags a beat, silence detection still finds the
real boundary because it's looking at the actual audio, not a timer.

This is the piece of the capture pipeline that's fully testable without real
audio hardware (see the test in the project's test suite) — the recorder and
browser automation can't be verified until run on your machine, but this
logic can be proven correct on synthetic audio first.
"""
import wave
from pathlib import Path

import numpy as np

from title_utils import sanitize_title


def _read_wav_mono(path: Path):
    with wave.open(str(path), "rb") as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)
    dtype = {1: np.int8, 2: np.int16, 4: np.int32}.get(sampwidth, np.int16)
    samples = np.frombuffer(raw, dtype=dtype).astype(np.float32)
    if n_channels > 1:
        samples = samples.reshape(-1, n_channels).mean(axis=1)
    return samples, framerate


def find_segments(path: Path, silence_thresh: float = 500.0, min_silence_len_sec: float = 0.8,
                   window_sec: float = 0.05):
    """
    Returns a list of (start_sec, end_sec) for each non-silent run in the
    recording, in order. silence_thresh is an RMS amplitude threshold on a
    16-bit scale (roughly -46dBFS by default) — deliberately conservative so
    normal quiet passages in a track aren't mistaken for the gap between tracks.
    """
    samples, framerate = _read_wav_mono(path)
    window_size = max(1, int(window_sec * framerate))
    n_windows = len(samples) // window_size

    is_silent = []
    for i in range(n_windows):
        window = samples[i * window_size:(i + 1) * window_size]
        rms = np.sqrt(np.mean(window ** 2)) if len(window) else 0.0
        is_silent.append(rms < silence_thresh)

    min_silence_windows = max(1, int(min_silence_len_sec / window_sec))
    segments = []
    start = None
    silence_run = 0
    for i, silent in enumerate(is_silent):
        if not silent:
            if start is None:
                start = i
            silence_run = 0
        else:
            if start is not None:
                silence_run += 1
                if silence_run >= min_silence_windows:
                    end = i - silence_run + 1
                    segments.append((start * window_sec, end * window_sec))
                    start = None
                    silence_run = 0
    if start is not None:
        segments.append((start * window_sec, len(is_silent) * window_sec))

    return segments, framerate


def extract_segments(path: Path, segments, titles, output_dir: Path, padding_sec: float = 0.15, log=print):
    """Writes each segment to output_dir/<title>/track.wav. If there are more
    segments than titles (or vice versa), extras are named generically rather
    than silently dropped, so nothing gets lost — check the log either way."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if len(segments) != len(titles):
        log(f"  ! detected {len(segments)} segments but expected {len(titles)} tracks — "
            f"check the log below carefully, some titles may be misaligned")

    with wave.open(str(path), "rb") as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()

        results = []
        for idx, (start_sec, end_sec) in enumerate(segments):
            title = titles[idx] if idx < len(titles) else f"Untitled Track {idx + 1}"
            safe_title = sanitize_title(title, f"track_{idx}")
            track_dir = output_dir / safe_title
            track_dir.mkdir(parents=True, exist_ok=True)

            start_frame = max(0, int((start_sec - padding_sec) * framerate))
            end_frame = int((end_sec + padding_sec) * framerate)
            wf.setpos(start_frame)
            frames = wf.readframes(end_frame - start_frame)

            out_path = track_dir / "track.wav"
            with wave.open(str(out_path), "wb") as out_wf:
                out_wf.setnchannels(n_channels)
                out_wf.setsampwidth(sampwidth)
                out_wf.setframerate(framerate)
                out_wf.writeframes(frames)

            log(f"  extracted: {title} ({end_sec - start_sec:.1f}s)")
            results.append(track_dir)

    return results


def split_recording(path: Path, titles, output_dir: Path, log=print):
    segments, _ = find_segments(path)
    return extract_segments(path, segments, titles, output_dir, log=log)
