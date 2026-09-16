"""
Drives a browser through Playwright to stay on suno.com/me and play each
track directly from its own inline row button — no navigating to individual
track pages at all, which this file used to do. That approach had two real
problems, both fixed by staying on the library page instead:

  - a track's own page has a "Similar" recommendations sidebar showing OTHER
    people's tracks; anything that touched it risked picking up someone
    else's song
  - full-page navigation between tracks turned out not to reliably preserve
    the browser's/tab's audio playback state across the jump, causing
    capture to behave unpredictably after the first track

ROW_TITLE_REGEX matches each row's own play button by its aria-label, which
Suno renders as `Play "Track Name"` — verified against real page HTML, not
guessed. That single pattern both finds the right buttons AND gives us the
track's exact title with no separate scraping step, and it's specific enough
to never match the plain "Play" button on an individual track's own page (no
quoted title there) or any other button on the page.

Uses a persistent browser profile (browser_profile/ next to the app). Log
into Suno there once, outside of Playwright's control — see login_to_suno.bat
and the note in orchestrator.py for why that matters (Google blocks sign-in
inside automation-driven browsers).
"""
import re
from pathlib import Path

SUNO_LIBRARY_URL = "https://suno.com/me"

# verified against real page HTML from the live site
ROW_TITLE_PATTERN = re.compile(r'^Play "(.*)"$', re.DOTALL)

BROWSER_CHANNEL = "chrome"  # uses your installed Chrome; set to None to use Playwright's bundled Chromium instead
AUDIO_ELEMENT_SELECTOR = "audio"
BROWSER_PROFILE_DIR = Path("browser_profile")
MAX_TRACK_WAIT_MS = 10 * 60 * 1000  # hard cap per track so a stuck page can't hang forever
MAX_SCROLL_ATTEMPTS = 100  # safety cap so a scroll loop can't run forever on an unusual page


def _all_row_buttons(page):
    """Every inline row play button currently in the DOM, matched by the
    aria-label pattern rather than a CSS selector (attribute selectors can't
    express "starts with 'Play \"'" cleanly, so this filters in Python)."""
    buttons = page.query_selector_all("button[aria-label]")
    return [b for b in buttons if ROW_TITLE_PATTERN.match(b.get_attribute("aria-label") or "")]


def _extract_title(button) -> str:
    label = button.get_attribute("aria-label") or ""
    match = ROW_TITLE_PATTERN.match(label)
    return match.group(1) if match else "Untitled"


def go_to_library(page):
    page.goto(SUNO_LIBRARY_URL)
    try:
        page.wait_for_function(
            "document.querySelectorAll('button[aria-label]').length > 0", timeout=20000
        )
    except Exception:
        pass  # the check below gives a clearer error either way

    if not _all_row_buttons(page):
        current_url = page.url
        if "suno.com/me" not in current_url or any(word in current_url.lower() for word in ("sign", "login", "auth")):
            raise RuntimeError(
                "Doesn't look like you're logged into Suno in this browser profile "
                f"(ended up at {current_url}). Run login_to_suno.bat once — log into Suno "
                "normally in the Chrome window it opens, then close that window — and try "
                "capture again."
            )
        raise RuntimeError(
            "Library page loaded but no track rows were found — Suno's page structure "
            "may have changed, check DevTools again"
        )


def _wait_for_count_to_grow(get_count, previous_count, max_wait_ms, poll_interval_ms=300) -> bool:
    import time as _time
    start = _time.monotonic()
    while (_time.monotonic() - start) * 1000 < max_wait_ms:
        if get_count() != previous_count:
            return True
        _time.sleep(poll_interval_ms / 1000)
    return False


def scroll_to_load_all(page, log=print) -> int:
    """
    Scrolls the library list to trigger lazy-loading until no new tracks
    appear for several scrolls in a row. Scrolls by bringing the last known
    row's button into view rather than assuming the whole window scrolls —
    Suno's library list scrolls inside an inner container instead, which
    window.scrollTo() wouldn't affect at all (this was the cause of only a
    small fraction of a much larger library ever being found).

    Waits up to 4s after each scroll for the count to actually grow, rather
    than a fixed short pause — real network-based lazy-loading can take
    longer than a brief fixed wait, and checking too early risks giving up
    thinking the list is done when a slower batch just hadn't arrived yet.
    Needs 5 consecutive scrolls that genuinely produce nothing (even after
    waiting) before deciding it's reached the end.
    """
    stable_rounds = 0
    last_count = len(_all_row_buttons(page))
    log(f"Starting scroll — {last_count} tracks visible before scrolling.")

    for i in range(MAX_SCROLL_ATTEMPTS):
        buttons = _all_row_buttons(page)
        if buttons:
            try:
                buttons[-1].scroll_into_view_if_needed(timeout=2000)
            except Exception:
                page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        else:
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")

        grew = _wait_for_count_to_grow(lambda: len(_all_row_buttons(page)), last_count, max_wait_ms=4000)
        new_count = len(_all_row_buttons(page))
        log(f"  scroll attempt {i + 1}: {new_count} tracks so far" + ("" if grew else " (no growth this attempt)"))

        if not grew:
            stable_rounds += 1
            if stable_rounds >= 5:  # no new tracks for 5 scrolls in a row, even after waiting 4s each = reached the end
                break
        else:
            stable_rounds = 0
            last_count = new_count

    total = len(_all_row_buttons(page))
    log(f"Scrolled through the library, found {total} tracks.")
    return total


def get_row_titles(page) -> list:
    """Titles in display order, for logging/progress — the actual buttons
    are re-queried fresh at play time since the DOM can shift between calls."""
    return [_extract_title(b) for b in _all_row_buttons(page)]


def play_row_and_wait(page, index: int, log=print) -> str:
    """
    Clicks the row at `index` (re-queried fresh, not a stale handle) and
    waits until it finishes playing. Returns the track's title (read at
    click time, so it reflects the actual row played even if the list
    shifted since the last full scan).
    """
    buttons = _all_row_buttons(page)
    if index >= len(buttons):
        raise IndexError(f"Row index {index} out of range ({len(buttons)} rows found)")

    button = buttons[index]
    title = _extract_title(button)
    button.click()

    page.wait_for_function(
        f"document.querySelector('{AUDIO_ELEMENT_SELECTOR}') && "
        f"document.querySelector('{AUDIO_ELEMENT_SELECTOR}').duration > 0",
        timeout=15000,
    )
    duration = page.evaluate(f"document.querySelector('{AUDIO_ELEMENT_SELECTOR}').duration")
    log(f"    playing, duration {duration:.1f}s")

    page.wait_for_function(
        f"document.querySelector('{AUDIO_ELEMENT_SELECTOR}').ended === true",
        timeout=min(int(duration * 1000) + 20000, MAX_TRACK_WAIT_MS),
    )

    return title
