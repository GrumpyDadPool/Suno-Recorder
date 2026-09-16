from pathlib import Path

from .base import PlatformPlugin
from spotify_prep import prepare_release


class SpotifyPrepPlugin(PlatformPlugin):
    platform_id = "spotify-prep"
    display_name = "Spotify (release prep)"

    def is_configured(self, cfg: dict) -> bool:
        return True  # no external creds needed, just builds a local package

    def upload(self, track_dir: Path, metadata: dict, cfg: dict, **kwargs) -> dict:
        release_dir = prepare_release(track_dir, cfg.get("artist_name", "Unknown Artist"))
        return {"detail": f"release package ready: {release_dir}"}
