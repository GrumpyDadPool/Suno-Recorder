# Suno Recorder

Chrome extension folder for **Suno Recorder** — load this directory unpacked.

Plays through `suno.com/me` and saves each track as **WAV** via tab audio
capture into a **subfolder under Chrome’s Downloads** (configurable; does not
change Chrome’s global download path).

## Install

`chrome://extensions` → Developer mode → **Load unpacked** → **this folder**.

**Required files:** [`FILES.md`](FILES.md)

## Use

1. Open `https://suno.com/me` (logged in)
2. Options → set **Save folder** (default `Suno Recorder`) and optionally
   **Scan a folder** so skip-done matches existing filenames
3. Start recording from the popup
4. **After every extension Reload, refresh the Suno tab**

Options: max tracks, filename prefix, save folder, skip done, speaker monitor (default on).

## Notes

- Only this tab’s audio is recorded (not system sounds / other apps)
- MediaRecorder captures WebM/Opus internally; converted to WAV before save
- Playback is paused after each track until encode + download settle (avoids
  playbar auto-next hitching under a heavy save)
- Version: see `manifest.json` (currently **1.3.0**)
