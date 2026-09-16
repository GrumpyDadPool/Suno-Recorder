# Suno Recorder (Chrome Extension)

Record your Suno library track-by-track with Chrome's `tabCapture` API — no
download quota, no Playwright, no separate login profile. Captures the same
legitimate audio your browser is already decoding.

Part of the **Suno Distributor** repo: this extension handles *capture*; the
Python app handles *organize + distribute* (SoundCloud, YouTube, Instagram,
Spotify-prep packages).

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this `chrome_extension/` folder

## Use

1. Log into Suno in Chrome as usual
2. Open `https://suno.com/me`
3. Click the extension icon → **Start recording**
4. It scrolls to load your library, plays each row's inline Play button, and
   saves one `.webm` per track to Chrome's download folder
5. Reopen the popup anytime for progress (capture keeps running if the popup closes)

**Options** (right-click the icon → Options, or the link in the popup):

- Max tracks per session (use 1–3 for a smoke test)
- Filename prefix
- Skip already-captured titles (resume)
- Optional speaker monitor (off = silent capture)

Point Chrome's download location (`chrome://settings/downloads`) at the folder
the Distributor watcher watches, then run `python main.py watch` / the GUI to
organize files into `output/`.

Convert WebM → WAV when you need masters for distribution:

```bash
ffmpeg -i "Track Name.webm" "Track Name.wav"
```

## How it works

Stays on `suno.com/me` for the whole session (never opens individual track
pages — those have a "Similar" sidebar of *other people's* songs, and
navigation used to break the capture stream). Records via the page's shared
`<audio>` element with one MediaRecorder per track.

## Why not the Python capture path?

| | Extension | `python main.py capture` (deprecated) |
|--|--|--|
| Login | Your normal Chrome session | Separate Playwright profile + `login_to_suno.bat` |
| Audio | Silent tab capture | Speakers play out loud (WASAPI loopback) |
| OS | Anywhere Chrome runs | Windows-oriented loopback stack |

See `../capture/DEPRECATED.md`.

## Troubleshooting

- Service worker errors: `chrome://extensions` → Suno Recorder → **service worker**
- Popup shows errors from `sunoCaptureError` in storage (relayed from the offscreen document)
- Start from a `suno.com` tab — `tabCapture` needs that user gesture on the right tab

## Changelog highlights

- **1.1.1** — Fix virtualized library scan (accumulate titles while scrolling,
  not DOM button count); find rows again when remounted; wait for real playback
  via media element *or* playbar; surface recorder/save errors instead of
  silently discarding every track; harden offscreen stream + download path
- **1.1.0** — Rebrand to Suno Recorder, polished popup/options, session lock,
  playback-start detection, unique-title scan, ArrayBuffer downloads (long tracks),
  keepalive alarm, optional speaker monitor, max-track smoke-test setting
- **1.0.x** — Initial tab-capture flow; fixed offscreen message races, scroll
  discovery, single stream acquisition on user gesture
