# Suno Recorder

Chrome extension folder for **Suno Recorder** — load this directory unpacked.

Plays through `suno.com/me` and saves each track as **WAV** via tab audio
capture into Chrome’s download folder.

## Install

`chrome://extensions` → Developer mode → **Load unpacked** → **this folder**.

**Required files:** [`FILES.md`](FILES.md)

## Use

1. Open `https://suno.com/me` (logged in)
2. Start recording from the popup
3. **After every extension Reload, refresh the Suno tab**

Options: max tracks, filename prefix, skip done, speaker monitor (default on).

## Notes

- Only this tab’s audio is recorded (not system sounds / other apps)
- MediaRecorder captures WebM/Opus internally; converted to WAV before save
- Version: see `manifest.json` (currently **1.2.1**)
