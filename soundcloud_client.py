"""
SoundCloud has a real public API. Docs: https://developers.soundcloud.com
You need a registered app (client_id/secret) and an OAuth access_token for
your own account — get these from https://soundcloud.com/you/apps.
"""
import requests
from pathlib import Path

API_BASE = "https://api.soundcloud.com"


class SoundCloudClient:
    def __init__(self, access_token: str):
        if not access_token:
            raise ValueError("soundcloud_access_token is empty — see README setup steps")
        self.access_token = access_token

    def upload_track(self, track_dir: Path, metadata: dict, ai_disclosure: bool = True) -> dict:
        audio_path = track_dir / "track.wav"
        if not audio_path.exists():
            audio_path = track_dir / "track.mp3"
        if not audio_path.exists():
            raise FileNotFoundError(f"No audio file found in {track_dir}")

        cover_path = track_dir / "cover.jpg"

        description = metadata.get("style_tags", "")
        if ai_disclosure:
            description = (description + "\n\n[AI-generated music, created with Suno]").strip()

        files = {
            "track[asset_data]": open(audio_path, "rb"),
        }
        if cover_path.exists():
            files["track[artwork_data]"] = open(cover_path, "rb")

        data = {
            "track[title]": metadata.get("title", "Untitled"),
            "track[description]": description,
            "track[sharing]": "public",
            "track[tag_list]": metadata.get("style_tags", ""),
        }

        try:
            resp = requests.post(
                f"{API_BASE}/tracks",
                params={"oauth_token": self.access_token},
                data=data,
                files=files,
                timeout=120,
            )
            resp.raise_for_status()
            return resp.json()
        finally:
            for f in files.values():
                f.close()
