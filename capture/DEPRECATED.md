# DEPRECATED — Python / Playwright capture

This folder is the **legacy** capture path (Playwright + WASAPI loopback).

**Prefer the Chrome extension instead:** [`../chrome_extension/`](../chrome_extension/)
(`Suno Recorder`). It runs inside your real Chrome session (no Google
automation login block), captures silently via `chrome.tabCapture`, and does
not need Windows-only loopback audio.

Kept in-tree for reference and for anyone who still needs the old flow, but
it is not the recommended path:

- Requires `login_to_suno.bat` + a local `browser_profile/` (never commit that
  profile — it holds cookies / login state)
- Speakers play audio out loud during capture
- Selectors and audio devices are machine-specific

`segment_splitter.py` remains useful as a tested utility if you ever need to
split a continuous recording again.
