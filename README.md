# Suno Recorder

Personal tool: pull your Suno library and push it out to SoundCloud, YouTube,
Instagram, and a Spotify-ready release package. Built for a Pro/Premier Suno
account (paid tier = commercial rights + WAV downloads).

## Getting your music off Suno now that downloads are quota-limited

Two capture paths exist, solving the same problem differently:

- **`chrome_extension/`** — a Chrome extension using tab audio capture.
  Runs inside your real browser session (no Google sign-in blocking, no
  separate login step), doesn't need to play out loud, and saves one clean
  file per track directly. See `chrome_extension/README.md`. **This is the
  recommended path** — fewer moving parts, fewer things that can go wrong.
- **`python main.py capture`** (below) — browser automation + system audio
  loopback recording. Built first, still works, needs a one-time manual
  login workaround and Windows-specific audio capture, but useful if you'd
  rather not install a browser extension.

Both record each track as its own file directly the moment it plays — no
splitting a long recording apart afterward, and both re-read the track's
title from its own page (not just the library list, which can go stale if a
track was renamed) so the saved filename matches what's actually shown.
Either way, captured files land in a folder the rest of this app already
knows how to pick up and organize (the same folder-watching logic as a
manual download).

It opens a real browser, plays through your entire library track by track,
and records the audio your speakers are actually outputting — the same idea
as recording what comes out of a speaker, just done digitally. It never
touches Suno's stream or its encryption; it only captures the legitimate
audio your own browser has already been allowed to decrypt and play, so it
doesn't involve circumventing anything.

**What this means in practice:**
- It takes as long as your library's total playtime — there's no way to
  speed this up without distorting the audio, it's genuinely real-time
- Your speakers play audio out loud during this (loopback recording captures
  what's playing, it can't do this silently) — the GUI warns you before starting
- Quality is whatever bitrate Suno streams at, not the WAV-master quality a
  proper download gives you — worth using your remaining download quota on
  your best/most important tracks first, and capture for the rest
- It resumes correctly — tracks already in `output/` get skipped on a re-run,
  so you can stop and restart across multiple sessions
- Each track is recorded as its own file the moment it plays — if capture
  gets interrupted partway through, everything captured before that point is
  already saved as complete, individual files, nothing to lose

**Before your first capture — log in once, by hand:**

Google blocks sign-in inside any automation-controlled browser (it detects
the automation flag and shows "this browser may not be secure") — this
happens with Chrome *or* Chromium, it's not specific to either. So logging in
has to happen outside of Playwright's control, once:

```
login_to_suno.bat
```

This opens a completely normal, non-automated Chrome window pointed at the
same profile folder capture reuses later. Log into Suno there like you
normally would, confirm you can see your library, then just close that
window. From then on, `python main.py capture` (or the GUI's Capture button)
reuses that already-logged-in session — Playwright only takes over after
login is done, so Google never sees an automated login attempt at all.

Also make sure Google Chrome is installed — capture drives your actual
installed Chrome (not a separate downloaded browser), so there's no extra
`playwright install` step needed for the common case. If Chrome isn't found,
it automatically falls back to Playwright's own bundled Chromium instead
(which *does* need a one-time `playwright install chromium`) — either way,
the log now tells you plainly which browser actually launched, so it's never
ambiguous which one you're looking at.

**Two things that genuinely need your machine to prove out**, flagged
honestly rather than pretended to work:
1. The row-button aria-label pattern in `capture/browser_player.py`
   (`Play "Track Name"`) — verified against real page HTML pulled from the
   live site, not guessed, but Suno's DOM could still differ in ways that
   haven't come up yet or change over time.
2. The loopback recorder (`capture/loopback_recorder.py`) needs real audio
   hardware to test, which this dev environment doesn't have. Try a short
   capture first (stop after 1-2 tracks) to confirm it's recording your
   system audio correctly before running a full library pass.

Capture stays on `suno.com/me` for the entire session — it never navigates
to an individual track's own page, which earlier versions did and which
caused two real problems: that page has a "Similar" recommendations sidebar
showing *other people's* tracks, and full-page navigation between tracks
didn't reliably preserve the browser's audio capture state. Staying on one
page and clicking each row's own inline Play button avoids both.

The per-track recording boundary logic (making sure each track's audio stays
cleanly separated, with no bleed from the track before or after it) **is**
fully tested — verified with simulated audio data against the actual
begin/end-track state machine.

## How Suno downloads work (updated — Cloudflare blocks direct API scripting)

Suno's API sits behind Cloudflare's Privacy Pass bot-detection challenge,
which only a real browser can satisfy — a script can't fake it (and
shouldn't try to). So this tool doesn't call Suno's API at all. Instead:

1. You download tracks yourself from suno.com in your normal browser, same as always
2. A folder watcher (`python main.py watch`, or the "Start Watching" button in
   the GUI) watches your browser's download folder in the background
3. The moment a `.wav`/`.mp3` lands there, it's automatically moved into
   `output/<track name>/track.wav` with a `metadata.json` stub created
   (`ai_generated: true`, etc.) — ready for the distribute step

This is "one click" in the sense that nothing after the click needs your
attention — organizing, tagging, and prepping for each platform all happen
automatically the moment the file hits disk.

**Set your Suno downloads folder in the app's Settings screen** to wherever
your browser saves downloads (e.g. `C:\Users\kevin\Downloads`, or set your
browser to save Suno downloads to a dedicated folder to keep things tidy).

### ⚠️ Suno's Sept 3, 2026 download quota
Suno enforces its own tier quota when you click Download on their site: Free =
7 lifetime, Pro = 20/month, Premier = 60/month. This tool can't see or affect
that — it only reacts to files that appear locally. It keeps an informational
local tally in `quota_state.json` (set `suno_tier` in config for this to be
accurate) but the real limit is enforced by Suno, not by this script.
Also worth knowing: commercial-use rights are now tied to having actually
downloaded that specific song within quota, not just being on a paid plan —
so download tracks deliberately, not everything you've ever made.

## What each platform actually supports

| Platform   | Automation level                                                   |
|------------|----------------------------------------------------------------------|
| Suno       | Semi-automated — you click Download in your browser, the watcher does the rest (organizing, tagging, metadata) |
| SoundCloud | Full — real public API, direct upload with title/art/tags            |
| YouTube    | Full — YouTube Data API v3, uploads to your own channel with AI-disclosure metadata set. Ad revenue via the Partner Program is a one-time channel-level enrollment you do separately in YouTube Studio, not per-upload. |
| Instagram  | Partial — Graph API can post a reel with audio via a Business/Creator account, but it wants a *video* container, so we generate a static-image video and post that; needs a publicly reachable video URL, not a raw upload |
| Spotify    | **Not directly automatable.** No individual-artist upload API exists. This tool builds a fully formatted "release package" (correct WAV spec, sized cover art, metadata.json with AI-disclosure fields) that you drag into a distributor (DistroKid / TuneCore / ONCE). That last step is a few manual clicks, not a script. |

## Setup

```
pip install -r requirements.txt
```

No config file to create — run `python gui.py` and use the **Settings**
screen (opens automatically on first run) to fill in:

- Your browser's download folder (see above)
- Suno tier — matches your actual subscription, used only for the informational quota tally
- SoundCloud client ID / client secret / access token — from https://soundcloud.com/you/apps
- Instagram access token / business account ID — from Meta's Graph API setup (requires an IG Business/Creator account linked to a Facebook Page)
- Artist name — used in the Spotify release metadata

Settings save to your Windows user profile (see "Configuring from within the
app" below) — CLI and GUI both read from the same saved settings, so you only
fill this in once regardless of which one you use.

### Setting up YouTube
1. In [Google Cloud Console](https://console.cloud.google.com), create a project and enable "YouTube Data API v3"
2. Create an OAuth Client ID (Application type: **Desktop app**)
3. Download the JSON and save it as `client_secret.json` next to `main.py`/`gui.py` (or next to the exe, if using the built version)
4. First `distribute --platforms youtube` run opens a browser to authorize your channel; after that, `token.json` is cached next to the app and won't ask again
5. Uploads default to `private` (`--youtube-privacy private`) so you can review before publishing — pass `--youtube-privacy public` once you're happy with it

## Configuring from within the app

Settings live independent of this project's folder entirely — no
`config.json` sitting around, and nothing lost if you rebuild the exe, move
it, or wipe and recreate the whole repo:

- **Non-secret fields** (folders, tier, artist name, IDs) → a small JSON
  file in your Windows user profile: `%APPDATA%\SunoDistributor\settings.json`
- **Secret fields** (SoundCloud/Instagram tokens) → **Windows Credential
  Manager**, via the `keyring` library. These are never written to disk as
  plain text at all — Windows encrypts them tied to your login, the same
  mechanism browsers and other apps use for saved passwords.

Click **Settings** in the GUI (opens automatically on first run) to fill
these in through a form — folder pickers, a tier dropdown, masked fields for
tokens. `core.load_config()` reads both stores and hands the rest of the app
one merged dict, so nothing downstream needs to know or care which value
came from where.

## Adding new distribution points

Two ways to add a platform beyond the four built in, both live in `platforms/`:

**No-code: custom webhooks.** In Settings, under "Custom Distribution Points,"
click Add and give it a name, a URL, and an auth token. It POSTs the track
(audio file, cover art, title, tags) as multipart form data to that URL. This
covers more than it sounds like — point it at a Zapier/Make.com/n8n webhook
and that tool can fan out to almost any other service, or point it directly
at any REST endpoint that accepts a file upload. Shows up as a normal
checkbox next to SoundCloud/YouTube/etc. the moment you save it, no restart
needed.

**Code: drop-in plugins.** For anything a webhook can't cover — a real SDK,
OAuth, chunked uploads — add a new `.py` file in `platforms/` with a class
that subclasses `PlatformPlugin` (see `platforms/base.py`) and implements
`is_configured(cfg)` and `upload(track_dir, metadata, cfg, **kwargs)`. It's
auto-discovered the moment the file exists — no registration step, nothing
else to edit. The four built-ins (`platforms/soundcloud_plugin.py` etc.) are
themselves just examples of this same pattern, not special-cased.

## Building a standalone .exe

```
build_exe.bat
```

Run this **on your actual Windows machine** — PyInstaller builds for whatever
OS it's running on, it can't cross-compile a Windows exe from anywhere else.
It installs PyInstaller if needed and produces `dist\Suno Distributor.exe`.

After building, keep these together in the same folder as the exe:
- `Suno Distributor.exe`
- `client_secret.json` (only needed once you use YouTube)

Settings themselves don't need anything copied over — they're saved to your
Windows user profile (see above), not the exe's folder, so they're already
there the moment you open Settings and fill them in, and stay there across
rebuilds.

The exe will be sizeable (100-200MB+) since it bundles Python, Tkinter,
moviepy, and the Google API libraries — that's normal for PyInstaller
one-file builds with this many dependencies, not a sign anything's wrong.

## GUI

```
python gui.py
```

Same underlying logic as the CLI (both call into `core.py`, so they can't drift
apart) — a window with a "Start Watching" toggle, a track list, checkboxes for
platforms, a YouTube visibility dropdown, "Distribute" buttons, and a log pane.
Uses Tkinter, which ships with the standard python.org Windows installer, so no
extra install beyond `requirements.txt`.

## CLI Usage

```
# See every platform currently available (built-ins + your custom webhooks)
python main.py list-platforms

# Start watching your downloads folder — leave this running, then go
# download tracks from suno.com; each one gets auto-organized as it lands
python main.py watch

# Push a specific track everywhere automatable
python main.py distribute --track "my_song_title" --platforms soundcloud,youtube,instagram,spotify-prep

# Push everything not yet distributed to SoundCloud + YouTube, keep YouTube private for review
python main.py distribute --all --platforms soundcloud,youtube --youtube-privacy private
```

Each track gets a folder under `output/<track_name>/` with:
- `track.wav` or `track.mp3` (whichever format you downloaded from Suno)
- `cover.jpg` — not auto-fetched anymore since that also came from the API;
  drop one in manually if you want art, or leave it out (SoundCloud/YouTube/
  Instagram all tolerate a missing cover and fall back to a placeholder)
- `lyrics.txt` — empty stub; fill in by hand if you want it distributed
- `metadata.json` (title inferred from the downloaded filename, **ai_generated: true**)
- `spotify_release/` — distributor-ready package if `spotify-prep` was requested
- `youtube.mp4` / `reel.mp4` — generated cover-art videos, built on demand

`state.json` tracks what's already been pushed where, so re-running `--all` is safe
and won't double-post. `quota_state.json` is the informational Suno download tally,
separate from state.json.

## Monetization notes

- Suno takes 0% of your streaming/YouTube royalties — Suno Pro/Premier gives commercial
  rights on any track you download within quota, with no revenue share back to Suno.
- Spotify and Apple Music now enforce AI-disclosure (DDEX standard) — the `spotify_prep`
  metadata already flags `ai_generated: true`. Skipping disclosure risks demonetization,
  playlist removal, or account strikes — not worth it even before getting into the ethics of it.
- Writing your own lyrics (rather than fully AI-generated ones) makes that composition
  copyrightable as a literary work and eligible for PRO (ASCAP/BMI) royalties, and is
  accepted by distributors who reject fully-AI content outright. Worth doing for tracks
  you're serious about monetizing.
- Avoid any tool marketed as removing "AI fingerprints" to dodge disclosure — beyond being
  the opposite of transparency, it's an increasingly fast route to account strikes now that
  disclosure is contractually required, not just encouraged.

## Security note

Never paste session tokens, cookies, or Bearer tokens into chat, a file
that might get committed to git, or anywhere shared — `token.json` (YouTube's
cached auth) and anything in your AppData settings folder are for your local
machine only. If a token you're using ever gets exposed (pasted somewhere,
screenshotted, etc.), treat it as compromised and get a fresh one.
