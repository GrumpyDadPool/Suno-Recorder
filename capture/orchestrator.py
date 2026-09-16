"""
Orchestrates a full capture session: opens a real browser, stays on
suno.com/me for the whole session, and plays each track directly from its
own row — no navigating away at all (see browser_player.py for why that
matters). The loopback recorder stays open for the whole session (cheaper
than reopening per track) but begin_track()/end_track() bound exactly what
gets written to each file, so tracks can never bleed into each other or need
to be split apart afterward.
"""
import json
import time
from pathlib import Path

from .loopback_recorder import LoopbackRecorder
from .browser_player import (
    go_to_library,
    scroll_to_load_all,
    get_row_titles,
    play_row_and_wait,
    BROWSER_PROFILE_DIR,
    BROWSER_CHANNEL,
)


def capture_library(output_dir: str, log=print, stop_event=None, skip_titles=None):
    """
    skip_titles: set of sanitized track-folder names already captured in a
    previous run (see title_utils.sanitize_title) — those get skipped so you
    can resume an interrupted session without re-recording everything.
    """
    from playwright.sync_api import sync_playwright  # imported here so this module can be
                                                        # inspected without playwright installed
    from title_utils import sanitize_title

    skip_titles = skip_titles or set()
    output_dir = Path(output_dir)

    recorder = LoopbackRecorder(log=log)
    recorder.start()

    captured = []
    try:
        with sync_playwright() as p:
            BROWSER_PROFILE_DIR.mkdir(exist_ok=True)
            launch_kwargs = {"headless": False}
            if BROWSER_CHANNEL:
                launch_kwargs["channel"] = BROWSER_CHANNEL
            used_channel = bool(BROWSER_CHANNEL)
            try:
                context = p.chromium.launch_persistent_context(str(BROWSER_PROFILE_DIR), **launch_kwargs)
            except Exception as e:
                if BROWSER_CHANNEL:
                    log(f"Couldn't launch Chrome (channel='{BROWSER_CHANNEL}'): {e}")
                    log("Falling back to Playwright's bundled Chromium — if this also fails, "
                        "run 'playwright install chromium' once and try again.")
                    context = p.chromium.launch_persistent_context(str(BROWSER_PROFILE_DIR), headless=False)
                    used_channel = False
                else:
                    raise
            page = context.new_page()

            try:
                browser_version = context.browser.version if context.browser else "unknown"
                log(f"Browser launched: {'Chrome' if used_channel else 'Chromium (bundled)'} (version {browser_version})")
            except Exception:
                pass

            go_to_library(page)
            total = scroll_to_load_all(page, log=log)
            titles_at_scan_time = get_row_titles(page)  # for progress logging only; re-read per row at play time

            for i in range(total):
                if stop_event is not None and stop_event.is_set():
                    log("Capture stopped early.")
                    break

                expected_title = titles_at_scan_time[i] if i < len(titles_at_scan_time) else f"row {i}"
                if sanitize_title(expected_title) in skip_titles:
                    log(f"Skipping (already captured): {expected_title}")
                    continue

                log(f"Playing ({i + 1}/{total}): {expected_title}")
                track_dir = None
                try:
                    recorder.begin_track()
                    title = play_row_and_wait(page, i, log=log)  # returns the title read at click time
                    time.sleep(0.3)  # small tail buffer so the end isn't clipped

                    safe_title = sanitize_title(title)
                    track_dir = output_dir / safe_title
                    track_path = track_dir / "track.wav"
                    recorder.end_track(track_path)

                    metadata = {
                        "title": title,
                        "style_tags": "",
                        "ai_generated": True,
                        "source": "suno",
                        "downloaded_via": "loopback capture during playback",
                    }
                    track_dir.mkdir(parents=True, exist_ok=True)
                    (track_dir / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")

                    log(f"    saved: {track_path}")
                    captured.append(track_dir)
                except Exception as e:
                    log(f"  ! failed to capture '{expected_title}': {e} — skipping, check the selectors "
                        f"in capture/browser_player.py against the real page")
                    if track_dir is not None:
                        try:
                            recorder.end_track(track_dir / "track_partial.wav")
                        except Exception:
                            pass

                time.sleep(1.0)  # brief pause between tracks

            context.close()
    except KeyboardInterrupt:
        log("Capture interrupted — whatever was already saved stays saved (each track is its own file).")
    except Exception as e:
        log(f"Capture stopped due to an error: {e}")
    finally:
        recorder.stop()

    log(f"Capture session complete — {len(captured)} tracks saved.")
    return captured
