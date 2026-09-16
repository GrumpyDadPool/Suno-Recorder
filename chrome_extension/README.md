# Suno Capture (Chrome Extension)

Plays through your Suno library and saves each track as its own clean audio
file, using Chrome's `tabCapture` API — no download quota involved, since
this never calls Suno's download endpoint at all. It captures the same
legitimate audio your browser is already decoding and playing, the same
category as recording what comes out of a speaker.

## How it works

Stays on `suno.com/me` for the entire session — it never navigates to an
individual track's own page. This matters for two reasons found during
testing:

- A track's own page has a "Similar" recommendations sidebar showing *other
  people's* tracks. Anything that touched that page risked picking up
  someone else's song.
- Full-page navigation between tracks didn't reliably preserve the tab's
  captured audio stream, which caused capture to behave unpredictably after
  the first track.

Instead, it scrolls the library list to load everything, then clicks each
row's own inline Play button directly and records via the page's single
shared audio player — recording starts exactly when Play is clicked and
stops exactly when that track ends, so each file is clean with nothing to
split apart afterward.

## Why this instead of the Python capture approach

- **No Google sign-in blocking.** This runs inside your actual Chrome
  session — not a separate automation-controlled browser — so there's no
  `navigator.webdriver` flag for Google to detect, and no separate one-time
  manual login step needed.
- **No Windows-only audio dependency.** `chrome.tabCapture` works wherever
  Chrome does; no WASAPI loopback, no `pyaudiowpatch`.
- **Doesn't need to play out loud.** The captured stream isn't routed back
  to your speakers, so capture runs silently.

## Installing (unpacked, for personal use — not published to the Web Store)

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**, select this `chrome_extension/` folder

## Using it

1. Log into Suno normally in Chrome, if you haven't already
2. Go to `suno.com/me`
3. Click the extension icon, click **Start Capture**
4. It scrolls to load your whole library, then plays through each row's own
   inline Play button one at a time, saving each as it finishes. Watch
   progress in the popup.
5. Files land wherever Chrome's default download location is set
   (`chrome://settings/downloads` → Location) — extensions can only write
   inside that folder, there's no way to target an arbitrary path like
   `Music\Suno` directly. Point Chrome's download folder at wherever you
   want captures to end up, and point the main app's folder watcher
   (`suno_watcher.py` / the Capture workflow's downloads folder in Settings)
   at that same folder so it picks these up automatically.

**Convert to WAV before distributing** — `MediaRecorder` only outputs
WebM/Opus, not WAV. A quick pass with ffmpeg handles this:
```
ffmpeg -i track.webm track.wav
```
(A batch conversion step for the whole download folder is a natural thing to
add to the main app if this ends up being the primary capture path — ask if
you want that wired in.)

## What's tested vs. what needs your machine

**Tested (with Node, against mocked data, not a real browser):**
- The title extraction regex against the *actual* aria-label pulled from a
  real page (`Play "Big Black Chalk"` → `Big Black Chalk`), including
  Suno's markdown-decorated title format, and confirmed it correctly does
  NOT match the plain "Play" button on an individual track page or any
  unrelated button
- The scroll-discovery loop, confirmed against a simulated ~300-track
  library that it finds everything rather than stalling early
- The title sanitizer matches the Python version's output exactly

**Not testable without a real Chrome + logged-in Suno session, so genuinely
unverified — try a short capture (1-2 tracks) before running your whole
library through it:**
- Whether the single shared `<audio>` element reliably reflects whichever
  row was most recently clicked. This is the current working assumption
  (a persistent bottom player bar is visible in Suno's UI, suggesting a
  single global audio element), but hasn't been proven against the live site.

## If something breaks

Open the extension's own DevTools to see console errors: `chrome://extensions`
→ Suno Capture → "service worker" link (for background.js errors) — for
offscreen document errors, they also surface via `chrome.storage.local`
(`sunoCaptureError`) and show up in the popup directly.

## History of fixed issues

**"Couldn't start capture: undefined" / "Cannot capture a tab with an active
stream"** — `chrome.runtime.sendMessage()` broadcasts to every listening part
of the extension, not just the intended one; the offscreen document was
sometimes answering messages meant for `background.js` before the real
handler could respond. Fixed with a `target` field every listener checks
before responding, plus always closing any leftover offscreen document
before starting a new session.

**Only finding ~15 tracks out of a much larger library** — the scan was
scrolling `window`, but Suno's library list scrolls inside an inner
container instead, so `window.scrollTo()` did nothing. Fixed by scrolling
the last-found row into view instead (`scrollIntoView()`), which works
regardless of which element is actually scrollable.

**Scrolling stops around the same point every time, no errors** — the wait
between scroll attempts was a fixed 800ms before checking whether more
tracks had loaded; real network-based lazy-loading can take longer than
that, especially for a large library, so the scan could give up thinking
it'd reached the end while a slower batch was still on its way. Changed to
actively wait (polling, up to 4s per attempt) for genuine growth before
counting an attempt as unproductive, and now needs 5 consecutive
genuinely-empty attempts instead of 3 before stopping. Being honest about
this one: synthetic timing tests weren't able to cleanly reproduce the exact
failure to prove this was the root cause with certainty — it's a strong,
principled improvement either way, but if scrolling still stalls after this,
the popup now logs every single scroll attempt with a running count, so
there'll be real data to diagnose from instead of guessing blind again.

**Capture plays the first track fine, then stops; also sometimes ended up
on someone else's song** — both were consequences of navigating to each
track's own page between tracks. Fixed by staying on `suno.com/me` for the
whole session and clicking each row's own inline Play button instead — see
"How it works" above.

**"Cannot read properties of undefined (reading 'download')" / silent
failures with no files saved** — offscreen documents have restricted access
to Chrome extension APIs; `chrome.downloads` isn't reliably available there,
and the fallback error-reporting path (`chrome.storage`) wasn't either,
which is why the failure looked so generic. Both are now relayed to
`background.js` (full service worker, unrestricted API access) via
messaging instead of `offscreen.js` touching either directly.

**Scrolling finishes, then capture does nothing — "Extension has not been
invoked for the current page (see activeTab permission)"** — this was a
side effect of an earlier fix. Acquiring a fresh capture stream per track
(added to defend against navigation breaking it) meant `chrome.tabCapture.getMediaStreamId()`
was being called well after the "Start Capture" click's user gesture had
gone stale — Chrome requires that gesture to still be fresh. Since capture
no longer navigates between tracks at all (previous fix), there's no longer
a reason to re-acquire per track: the stream is now acquired exactly once,
immediately when you click Start Capture, which is the one moment
guaranteed to count as a valid gesture. Verified this now happens exactly
once for a whole multi-track session rather than once per track.
