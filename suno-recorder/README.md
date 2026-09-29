# Suno Recorder

Chrome extension folder for **Suno Recorder** — load this directory unpacked.

Plays through `suno.com/me` and saves each track as **WAV** via tab audio
capture into a subfolder of Chrome’s download folder (default `Suno Recorder`).
Lyrics and the cover image are saved beside the WAV when the page shows them.

## Install

`chrome://extensions` → Developer mode → **Load unpacked** → **this folder**.

**Required files:** [`FILES.md`](FILES.md)

## Use

1. Open `https://suno.com/me` (logged in)
2. **Start recording** presses Home, then Page Up until nothing new appears, then Page Down, and plays through the library. **One song** starts immediately when a title is already on the bottom play bar; otherwise it waits until you put a song there, and only Stop cancels that wait. It then presses the play bar’s play button. Capture stops when the play bar changes. It does not move the library. **Lyrics and covers** uses that same Home, Page Up, then Page Down order, opens each song, and saves its lyric text and cover image, without recording audio.
3. **After every extension Reload, refresh the Suno tab**

Options: max tracks, filename prefix, **save folder**, skip done, **recorded songs** (remove a title to record it again), folder scan, speaker monitor (default on).

## Notes

- Only this tab’s audio is recorded (not system sounds / other apps)
- The toolbar icon **pulses while a capture session is active** and returns to
  the static icon when it stops
- MediaRecorder captures WebM/Opus internally; converted to WAV before save
- Files save to `Downloads/<save folder>/<prefix><title>.wav`, plus `.txt` lyrics when that song's panel shows them and a `.jpg`, `.png`, or `.webp` cover. Lyrics and covers opens each song's panel before saving.
- On each track end the playbar is paused before encode/download, so Suno’s
  auto-advance can’t hitch the next track (no MediaRecorder timeslice; the
  recorder warms up ≥700ms before playback so intros aren’t clipped)
- Version: see `manifest.json` (currently **1.6**)
