# Suno Recorder

Chrome extension folder for **Suno Recorder** — load this directory unpacked.

Plays through `suno.com/me` and saves each track as **WAV** via tab audio
capture into a subfolder of Chrome’s download folder (default `Suno Recorder`).

## Install

`chrome://extensions` → Developer mode → **Load unpacked** → **this folder**.

**Required files:** [`FILES.md`](FILES.md)

## Use

1. Open `https://suno.com/me` (logged in)
2. Start recording from the popup
3. **After every extension Reload, refresh the Suno tab**

Options: max tracks, filename prefix, **save folder**, skip done (+ optional
**scan a folder**), speaker monitor (default on).

## Notes

- Only this tab’s audio is recorded (not system sounds / other apps)
- MediaRecorder captures WebM/Opus internally; converted to WAV before save
- Files save to `Downloads/<save folder>/<prefix><title>.wav`
- On each track end the playbar is paused before encode/download, so Suno’s
  auto-advance can’t hitch the next track (no MediaRecorder timeslice; the
  recorder warms up ≥700ms before playback so intros aren’t clipped)
- Version: see `manifest.json` (currently **1.3.0**)
