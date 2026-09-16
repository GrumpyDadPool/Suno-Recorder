from pathlib import Path

from .base import PlatformPlugin


class InstagramPlugin(PlatformPlugin):
    platform_id = "instagram"
    display_name = "Instagram"

    def is_configured(self, cfg: dict) -> bool:
        return bool(cfg.get("instagram_access_token") and cfg.get("instagram_business_account_id"))

    def upload(self, track_dir: Path, metadata: dict, cfg: dict, **kwargs) -> dict:
        return {"detail": "build the reel video then host the mp4 somewhere public before it can "
                           "publish — see README, not fully one-click yet"}
