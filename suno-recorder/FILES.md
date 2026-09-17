# Suno Recorder — required files

Load **this folder** (`suno-recorder/`) via Chrome → Extensions → **Load unpacked**.

Anything outside this folder is not needed for the extension to run.

## Required (do not delete)

| Path | Why |
|------|-----|
| `manifest.json` | Extension identity, permissions, entry points |
| `background.js` | Service worker: tabCapture, downloads, offscreen relay |
| `content.js` | Runs on `suno.com` — library scan + play control |
| `title_utils.js` | Shared title → filename sanitizer (loaded before content.js) |
| `offscreen.html` | Host page for the offscreen recorder document |
| `offscreen.js` | MediaRecorder + WAV encode |
| `popup.html` | Toolbar popup UI |
| `popup.js` | Start/stop + status |
| `popup.css` | Popup + options styling |
| `options.html` | Options page |
| `options.js` | Options persistence |
| `icons/icon16.png` | Toolbar / management UI |
| `icons/icon32.png` | Toolbar / management UI |
| `icons/icon48.png` | Toolbar / management UI |
| `icons/icon128.png` | Chrome management UI |
| `fonts/syne-700.woff2` | Brand display font |
| `fonts/syne-800.woff2` | Brand display font |
| `fonts/figtree-400.woff2` | UI body font |

## Optional (safe to delete locally)

| Path | Notes |
|------|-------|
| `README.md` | Human docs only |
| `FILES.md` | This manifesto |
| `test_title_utils.js` | Node unit check (`node test_title_utils.js`); not loaded by Chrome |

## Repo root (next to `suno-recorder/`)

| Path | Keep? |
|------|-------|
| `README.md` | Yes — install / usage |
| `.gitignore` | Yes |

## Safe to delete on your machine (legacy)

If these still exist from older clones, they are **not** used:

- `chrome_extension/` (old folder name — use `suno-recorder/` instead)
- `capture/`, `platforms/`, Python Distributor files (`*.py`, `requirements.txt`, …)
- `login_to_suno.bat`, `build_exe.bat`, `*.spec`
- `browser_profile/` (never commit — cookies/login data)
- `config.json`, `token.json`, `client_secret.json`, `output/`, `*.zip`

## Quick local checklist

1. Point Chrome **Load unpacked** at `suno-recorder/` (this folder).
2. After every extension **Reload**, refresh `https://suno.com/me` before Start.
3. Delete any leftover `chrome_extension/` or Python/Playwright paths if present.
