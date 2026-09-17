# Suno Recorder

Personal Chrome extension that records your [Suno](https://suno.com/me) library
track-by-track and saves each song as a **WAV** file to Chrome’s download folder.

Uses Chrome **tab audio capture** — no Suno download quota, no Playwright, no
system-wide loopback. Only that tab’s audio is recorded.

**Repo:** [GrumpyDadPool/Suno-Recorder](https://github.com/GrumpyDadPool/Suno-Recorder)

## Install (unpacked)

1. Clone this repo:
   ```bash
   git clone https://github.com/GrumpyDadPool/Suno-Recorder.git
   cd Suno-Recorder
   ```
2. Open `chrome://extensions`
3. Turn on **Developer mode**
4. **Load unpacked** → select the `suno-recorder/` folder

Required vs optional files: [`suno-recorder/FILES.md`](suno-recorder/FILES.md)

## Use

1. Log into Suno in Chrome
2. Open `https://suno.com/me`
3. Click the **Suno Recorder** icon → **Start recording**
4. WAVs appear in Chrome’s download location (`chrome://settings/downloads`)

**After every extension Reload, refresh the Suno tab** before starting again
(avoids “Extension context invalidated”).

### Options

Right-click the icon → **Options** (or the link in the popup):

| Option | Purpose |
|--------|---------|
| Max tracks per session | Use `1`–`3` for a smoke test; `0` = whole library |
| Filename prefix | Optional prefix before the sanitized title |
| Skip already captured | Resume-friendly skip of titles marked done |
| Speaker monitor | On by default — hear the tab while capturing |

### Tips

- Tab capture records **only the Suno tab** (not mic, other apps, or system sounds)
- Stop is respected during library scan and between tracks
- If Start seems stuck: Stop, refresh `suno.com/me`, Start again

## How it works

1. Acquires a one-time tab-capture stream when you click Start
2. Scrolls the virtualized `/me` library and collects unique track titles
3. Remounts each row, clicks Play, confirms playback, records, encodes **WAV**
4. Saves via `chrome.downloads` into your Chrome download folder

Chrome’s `MediaRecorder` only emits WebM/Opus internally; the extension decodes
that to WAV so files open in normal players.

## Project layout

```
Suno-Recorder/
├── README.md                 ← you are here
├── .gitignore
└── suno-recorder/            ← Load unpacked this folder
    ├── FILES.md              ← required-file manifesto
    ├── manifest.json         ← v1.2.0
    ├── background.js
    ├── content.js
    ├── title_utils.js
    ├── offscreen.html / .js
    ├── popup.html / .js / .css
    ├── options.html / .js
    ├── icons/
    ├── fonts/
    └── test_title_utils.js   ← optional Node check
```

Legacy Playwright / Python “Distributor” code has been removed from this repo.

## Development

```bash
cd suno-recorder
node test_title_utils.js
```

Version: see `suno-recorder/manifest.json`.
