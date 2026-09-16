from pathlib import Path

from .base import PlatformPlugin
from soundcloud_client import SoundCloudClient


class SoundCloudPlugin(PlatformPlugin):
    platform_id = "soundcloud"
    display_name = "SoundCloud"

    def is_configured(self, cfg: dict) -> bool:
        return bool(cfg.get("soundcloud_access_token"))

    def upload(self, track_dir: Path, metadata: dict, cfg: dict, **kwargs) -> dict:
        client = SoundCloudClient(cfg["soundcloud_access_token"])
        result = client.upload_track(track_dir, metadata)
        return {"detail": result.get("permalink_url", "uploaded")}
