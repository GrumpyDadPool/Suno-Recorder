# Suno Recorder

Chrome extension that plays through your [Suno](https://suno.com/me) library and
saves each track as a **WAV** file to Chrome’s download folder — using tab
audio capture (no Suno download quota, no system-wide loopback).

## Install

1. Clone or pull this repo
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. **Load unpacked** → select the `chrome_extension/` folder

See [`chrome_extension/FILES.md`](chrome_extension/FILES.md) for the exact
file list (what’s required vs safe to delete).

## Use

1. Log into Suno in Chrome
2. Open `https://suno.com/me`
3. Click the extension → **Start recording**
4. Files land in Chrome’s download location (`chrome://settings/downloads`)

**After every extension Reload, refresh the Suno tab** before starting again.

### Options

- Max tracks per session (use `1`–`3` to smoke-test)
- Filename prefix
- Skip already-captured titles
- Speaker monitor (on by default so you can hear capture)

## How it works

- Stays on `/me` (no per-track page navigation)
- Scrolls a virtualized library while collecting unique titles
- Clicks each row’s Play control and records that tab’s audio
- Decodes MediaRecorder output to WAV for normal players / tools

Tab capture records **only that tab** — other apps and system sounds are not included.

## Development

```bash
cd chrome_extension
node test_title_utils.js   # optional sanitizer check
```

Current version: see `chrome_extension/manifest.json`.

## License / account

Personal tool. Requires your own Suno login in Chrome. Do not commit browser
profiles, tokens, or download folders.
