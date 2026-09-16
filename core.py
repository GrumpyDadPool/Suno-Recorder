"""
Shared orchestration logic used by both main.py (CLI) and gui.py, so the two
front ends never drift out of sync — they call the exact same functions.
"""
import json
import os
import sys
from pathlib import Path

# state.json and quota_state.json live next to the app and are just local
# tracking data (not secrets), so a relative path is fine for those — but
# that only works if the process's working directory is the right folder,
# which isn't guaranteed when double-clicking gui.py in File Explorer,
# launching from an IDE, or (once packaged) running the PyInstaller .exe,
# which unpacks itself into a temporary folder at runtime rather than
# running from where the .exe sits. This resolves the *real* project folder
# in all three cases and pins cwd to it.
if getattr(sys, "frozen", False):
    PROJECT_DIR = Path(sys.executable).resolve().parent
else:
    PROJECT_DIR = Path(__file__).resolve().parent
os.chdir(PROJECT_DIR)

from suno_watcher import watch_downloads as _watch_downloads
from platforms import get_all_platforms
import secure_config

STATE_FILE = PROJECT_DIR / "state.json"


def load_config() -> dict:
    if not secure_config.has_settings():
        raise FileNotFoundError(
            "No settings saved yet — run 'python gui.py' once and use Settings to set them up "
            "(CLI and GUI share the same saved settings after that)."
        )
    return secure_config.load_settings()


def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    return {}


def save_state(state: dict):
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def list_track_dirs(cfg: dict):
    output_dir = Path(cfg.get("output_dir", "output"))
    output_dir.mkdir(exist_ok=True, parents=True)
    return sorted([d for d in output_dir.iterdir() if d.is_dir() and (d / "metadata.json").exists()])


def capture_suno_library(cfg: dict, stop_event=None, log=print):
    """
    Plays through your whole Suno library in a real browser while recording
    loopback audio, then splits the result into output/<title>/track.wav —
    the alternative path now that Suno's own download quota is too small to
    rely on. See capture/orchestrator.py for the pieces involved.
    """
    from capture.orchestrator import capture_library as _capture_library
    from title_utils import sanitize_title

    already_captured = {sanitize_title(d.name) for d in list_track_dirs(cfg)}
    return _capture_library(
        cfg.get("output_dir", "output"),
        log=log,
        stop_event=stop_event,
        skip_titles=already_captured,
    )


def watch_suno_downloads(cfg: dict, stop_event=None, log=print):
    """
    Watches cfg['suno_downloads_watch_folder'] (your browser's download
    location) and auto-organizes any new Suno .wav/.mp3 into output/<title>/
    as you manually click Download on suno.com. Runs until stop_event is set
    (GUI) or interrupted with Ctrl+C (CLI).
    """
    watch_folder = cfg.get("suno_downloads_watch_folder")
    if not watch_folder:
        raise ValueError("suno_downloads_watch_folder not set — open Settings")
    _watch_downloads(
        watch_folder,
        cfg.get("output_dir", "output"),
        tier=cfg.get("suno_tier", "pro"),
        log=log,
        stop_event=stop_event,
    )


def list_available_platforms(cfg: dict):
    """Returns {platform_id: plugin_instance} for everything currently usable —
    built-ins plus any configured custom webhooks. Used by both the GUI's
    checkbox list and CLI validation, so they're always in sync."""
    return get_all_platforms(cfg)


def distribute_tracks(cfg: dict, track_dirs, platform_ids, youtube_privacy: str = "private", log=print):
    """
    track_dirs: list of Path objects (from list_track_dirs, filtered as needed)
    platform_ids: list of platform_id strings — see list_available_platforms(cfg)
                  for what's currently available (built-ins + custom webhooks)
    """
    state = load_state()
    platforms = get_all_platforms(cfg)

    for track_dir in track_dirs:
        meta_path = track_dir / "metadata.json"
        if not meta_path.exists():
            continue
        metadata = json.loads(meta_path.read_text(encoding="utf-8"))
        track_state = state.setdefault(track_dir.name, {})

        for platform_id in platform_ids:
            if track_state.get(platform_id):
                continue  # already done for this track

            plugin = platforms.get(platform_id)
            if plugin is None:
                log(f"  [{track_dir.name}] unknown platform '{platform_id}', skipping")
                continue
            if not plugin.is_configured(cfg):
                log(f"  [{track_dir.name}] {plugin.display_name} isn't configured yet, skipping")
                continue

            try:
                result = plugin.upload(track_dir, metadata, cfg, youtube_privacy=youtube_privacy)
                track_state[platform_id] = result.get("detail", "done")
                log(f"  [{track_dir.name}] {plugin.display_name}: {track_state[platform_id]}")
            except Exception as e:
                log(f"  [{track_dir.name}] {plugin.display_name} failed: {e}")

        save_state(state)

    return state
