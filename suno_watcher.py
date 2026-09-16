"""
Suno's API sits behind Cloudflare's Privacy Pass (PrivateToken) bot challenge,
which a plain script can't satisfy — only a real browser can. So instead of
calling the API directly, this watches a folder (your browser's download
location) for new files and organizes them the moment you click Download on
suno.com yourself. You still do the clicking; everything after that —
renaming, folder structure, metadata.json — is automatic.

--- Sept 3, 2026 download quota reminder ---
Suno enforces its own tier quota (Free 7 lifetime, Pro 20/mo, Premier 60/mo)
on its end when you click Download — this watcher can't see or affect that,
it just organizes whatever lands in the watch folder. It does keep a local
running count for your own visibility, informational only.
"""
import json
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

from title_utils import sanitize_title

AUDIO_EXTENSIONS = {".wav", ".mp3"}
QUOTA_LOG_FILE = Path("quota_state.json")

TIER_QUOTAS = {
    "free": 7,
    "pro": 20,
    "premier": 60,
}


def _is_file_stable(path: Path, checks: int = 3, interval: float = 1.0) -> bool:
    """Waits until a file's size stops changing, so we don't grab a
    still-downloading (.crdownload-adjacent) file mid-write."""
    last_size = -1
    stable_count = 0
    for _ in range(30):  # ~30s max wait
        try:
            size = path.stat().st_size
        except FileNotFoundError:
            return False
        if size == last_size and size > 0:
            stable_count += 1
            if stable_count >= checks:
                return True
        else:
            stable_count = 0
        last_size = size
        time.sleep(interval)
    return False


def _log_quota_progress(tier: str, log):
    if tier not in TIER_QUOTAS:
        return
    state = {"period_start": None, "count": 0}
    if QUOTA_LOG_FILE.exists():
        state = json.loads(QUOTA_LOG_FILE.read_text(encoding="utf-8"))

    now = datetime.now(timezone.utc)
    period_start = state.get("period_start")
    if tier != "free" and (not period_start or _months_between(period_start, now) >= 1):
        state["period_start"] = now.isoformat()
        state["count"] = 0
    elif not period_start:
        state["period_start"] = now.isoformat()

    state["count"] = state.get("count", 0) + 1
    QUOTA_LOG_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")

    cap = TIER_QUOTAS[tier]
    log(f"  (informational) {state['count']}/{cap} Suno downloads logged this period — "
        f"Suno enforces the real limit on their end, this is just a local tally")


def _months_between(iso_str: str, now: datetime) -> int:
    then = datetime.fromisoformat(iso_str)
    return (now.year - then.year) * 12 + (now.month - then.month)


def organize_file(src_path: Path, output_dir: Path, log=print) -> Path:
    """Moves one downloaded audio file into output/<title>/track.<ext> with a metadata.json stub."""
    title = sanitize_title(src_path.stem, src_path.stem)
    track_dir = output_dir / title
    track_dir.mkdir(parents=True, exist_ok=True)

    dest = track_dir / f"track{src_path.suffix.lower()}"
    shutil.move(str(src_path), str(dest))

    meta_path = track_dir / "metadata.json"
    if meta_path.exists():
        metadata = json.loads(meta_path.read_text(encoding="utf-8"))
    else:
        metadata = {
            "title": title,
            "style_tags": "",
            "ai_generated": True,
            "source": "suno",
            "downloaded_via": "manual browser download",
            "organized_at": datetime.now(timezone.utc).isoformat(),
        }
    meta_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    lyrics_path = track_dir / "lyrics.txt"
    if not lyrics_path.exists():
        lyrics_path.write_text("", encoding="utf-8")  # Suno doesn't hand this over via file download; fill in by hand if needed

    log(f"  organized: {title} ({src_path.suffix})")
    return track_dir


def watch_downloads(watch_folder: str, output_dir: str, tier: str = "pro", log=print, stop_event=None):
    """
    Polls watch_folder for new audio files and organizes each one into
    output_dir/<title>/. Runs until stop_event is set (for the GUI) or
    interrupted (Ctrl+C, for the CLI).
    """
    watch_path = Path(watch_folder)
    out_path = Path(output_dir)
    out_path.mkdir(parents=True, exist_ok=True)
    if not watch_path.exists():
        raise FileNotFoundError(f"Watch folder does not exist: {watch_path}")

    log(f"Watching {watch_path} for new Suno downloads (.wav / .mp3)... download tracks from suno.com now.")
    seen = {p.name for p in watch_path.iterdir() if p.is_file()}

    while True:
        if stop_event is not None and stop_event.is_set():
            log("Stopped watching.")
            return

        try:
            current_files = {p.name: p for p in watch_path.iterdir() if p.is_file()}
        except FileNotFoundError:
            time.sleep(2)
            continue

        new_names = set(current_files) - seen
        for name in new_names:
            path = current_files[name]
            if path.suffix.lower() not in AUDIO_EXTENSIONS:
                seen.add(name)
                continue
            if not _is_file_stable(path):
                continue  # still downloading, check again next loop
            organize_file(path, out_path, log=log)
            _log_quota_progress(tier, log)
            seen.add(name)

        time.sleep(2)
