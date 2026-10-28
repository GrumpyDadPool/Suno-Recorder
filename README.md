# Suno Recorder

A Chrome extension that walks your [Suno](https://suno.com) library
track-by-track and saves each song as a **WAV** file, with lyrics and cover
art saved alongside — through Chrome tab audio capture, on your machine.

No download quotas, no system-wide loopback, no accounts, no servers.
Everything stays local.

## What it does

Three modes, from the toolbar popup on `suno.com/me`:

- **Start recording** — scrolls your library top to bottom, plays each track,
  and saves it as WAV. Songs already on the recorded list are skipped.
- **One song** — records whatever is on the play bar right now (or waits for
  you to queue one). Only Stop cancels the wait.
- **Lyrics and covers** — opens each song and saves its lyric text (`.txt`,
  style prompt on top) and cover image (`.jpg` / `.png` / `.webp`), without
  recording audio.

Files land in `Downloads/<save folder>/<prefix><title>.wav` (default folder
`Suno Recorder`).

## Install

1. Clone this repo.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. **Load unpacked** → select the `suno-recorder/` folder.

**After every extension Reload, refresh your Suno tab** before starting —
otherwise the content script is running a stale context.

Required vs. optional files: [`suno-recorder/FILES.md`](suno-recorder/FILES.md)

## Options

Right-click the toolbar icon → **Options**:

| Option | What it does |
|--------|--------------|
| Max tracks per session | `0` = entire library; use `1`–`3` for a smoke test |
| Filename prefix | Optional prefix before the sanitized title |
| Save folder | Subfolder inside your Chrome downloads folder |
| Skip songs on the recorded list | Don't re-record finished songs |
| Play captured audio through speakers | Monitor while recording (default on) |
| Scan a folder | One-time import of existing downloads into the recorded list |
| Recorded songs | Remove a title to record that song again |

## Notes

- Only the Suno tab's audio is recorded — not system sounds or other apps.
- The toolbar icon pulses while a capture session is active.
- MediaRecorder captures WebM/Opus internally; audio is converted to WAV
  before saving.
- On each track end the play bar is paused before encode/download, so Suno's
  auto-advance can't clip the next track's intro.
- If a session looks stuck, the popup resets it instead of hanging forever.

## Privacy

The extension talks only to `suno.com` and `cdn2.suno.ai` (cover art). No
analytics, no account, no backend — your library, lyrics, and audio never
leave your machine.

One permission deserves an explanation: the extension asks for Chrome's
`debugger` permission solely to send trusted Home / Page Up / Page Down key
presses, which is how it scrolls your library without starting playback.
While a key is being sent, Chrome shows a "Suno Recorder is debugging this
browser" banner — the debugger attaches, sends the key, and detaches
immediately. It is never used to inspect pages or network traffic.

## Version

See `suno-recorder/manifest.json` (currently **1.6.18**).

## License

MIT — see [LICENSE](LICENSE).
