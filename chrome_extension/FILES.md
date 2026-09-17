# Suno Recorder — required files

Load **this folder** (`chrome_extension/`) via Chrome → Extensions → Load unpacked.

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
| `icons/icon128.png` | Chrome Web Store / management UI |
| `fonts/syne-700.woff2` | Brand display font |
| `fonts/syne-800.woff2` | Brand display font |
| `fonts/figtree-400.woff2` | UI body font |

## Optional (safe to delete locally)

| Path | Notes |
|------|-------|
| `README.md` | Human docs only |
| `FILES.md` | This manifesto |
| `test_title_utils.js` | Node unit check (`node test_title_utils.js`); not loaded by Chrome |

## Repo root (next to `chrome_extension/`)

| Path | Keep? |
|------|-------|
| `README.md` | Yes — install / usage |
| `.gitignore` | Yes |

## Safe to delete on your machine (legacy Distributor / Playwright)

If these still exist locally from older clones, they are **not** used by the extension:

- `capture/`, `platforms/`
- `main.py`, `gui.py`, `core.py`, `*_client.py`, `*_watcher.py`, `title_utils.py`, …
- `requirements.txt`, `config.json`, `config.example.json`
- `login_to_suno.bat`, `build_exe.bat`, `*.spec`
- `browser_profile/` (never commit — cookies/login data)
- `suno-distributor.zip`, `output/`, `token.json`, `client_secret.json`

## Quick local cleanup checklist

1. Keep a folder that contains everything under **Required** above (usually `chrome_extension/`).
2. Point Chrome “Load unpacked” at that folder.
3. Delete legacy Python / Playwright / Distributor paths listed above if you no longer need them.
4. After every extension **Reload**, refresh `https://suno.com/me` before Start.
