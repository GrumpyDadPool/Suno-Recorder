from pathlib import Path

from .base import PlatformPlugin
from youtube_client import YouTubeClient


class YouTubePlugin(PlatformPlugin):
    platform_id = "youtube"
    display_name = "YouTube"

    def __init__(self):
        self._client = None  # lazy: only auth (OAuth browser flow) if actually used

    def is_configured(self, cfg: dict) -> bool:
        return True  # auth happens via its own OAuth flow (client_secret.json), not cfg fields

    def upload(self, track_dir: Path, metadata: dict, cfg: dict, **kwargs) -> dict:
        if self._client is None:
            self._client = YouTubeClient()
        privacy = kwargs.get("youtube_privacy", "private")
        result = self._client.upload_track(track_dir, metadata, privacy_status=privacy)
        return {"detail": f"https://youtu.be/{result['id']}"}
