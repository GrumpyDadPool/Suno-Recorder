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
2. **Start recording** plays through the library. **One song** starts immediately when a title is already on the bottom play bar; otherwise it waits until you put a song there, and only Stop cancels that wait. It then presses the play bar’s play button. Capture stops when the play bar changes. **Lyrics and covers** scrolls the library and saves only lyric text and cover images, without recording audio.
3. **After every extension Reload, refresh the Suno tab**

Options: max tracks, filename prefix, **save folder**, skip done, **recorded songs** (remove a title to record it again), folder scan, speaker monitor (default on).

## Notes

- Only this tab’s audio is recorded (not system sounds / other apps)
- MediaRecorder captures WebM/Opus internally; converted to WAV before save
- Files save to `Downloads/<save folder>/<prefix><title>.wav`, plus `.txt` lyrics when the open song panel shows them and a `.jpg`, `.png`, or `.webp` cover from the play bar or that panel
- Version: see `manifest.json` (currently **1.5.5**)
