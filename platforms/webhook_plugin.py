"""
One instance of this = one user-configured custom distribution point, added
from the Settings screen with no code. POSTs the track as multipart form
data (audio file + cover art + metadata fields) to whatever URL you give it.

This is what makes "almost any platform" reachable without writing a plugin
file for each one: point it at a webhook from an automation tool (Zapier,
Make.com, n8n, IFTTT) and that tool fans out to whatever service it
integrates with — or point it directly at any REST endpoint that accepts a
multipart upload.

is_custom = True marks this as a runtime-created plugin (built from a config
dict, not a fixed file) — registry.py treats it differently from the
auto-discovered built-in plugins for that reason.
"""
from pathlib import Path

import requests

from .base import PlatformPlugin


class WebhookPlugin(PlatformPlugin):
    is_custom = True

    def __init__(self, webhook_cfg: dict):
        self.webhook_cfg = webhook_cfg
        self.platform_id = f"webhook:{webhook_cfg['id']}"
        self.display_name = webhook_cfg.get("name") or "Custom Webhook"

    def is_configured(self, cfg: dict) -> bool:
        return bool(self.webhook_cfg.get("url"))

    def upload(self, track_dir: Path, metadata: dict, cfg: dict, **kwargs) -> dict:
        url = self.webhook_cfg["url"]
        header_name = (self.webhook_cfg.get("auth_header_name") or "").strip() or "Authorization"
        token = self.webhook_cfg.get("auth_token", "")

        headers = {}
        if token:
            headers[header_name] = f"Bearer {token}" if header_name == "Authorization" else token

        audio_path = track_dir / "track.wav"
        if not audio_path.exists():
            audio_path = track_dir / "track.mp3"
        if not audio_path.exists():
            raise FileNotFoundError(f"No audio file found in {track_dir}")

        files = {"audio": open(audio_path, "rb")}
        cover_path = track_dir / "cover.jpg"
        if cover_path.exists():
            files["cover"] = open(cover_path, "rb")

        data = {
            "title": metadata.get("title", "Untitled"),
            "style_tags": metadata.get("style_tags", ""),
            "ai_generated": "true",
            "source": "suno",
        }

        try:
            resp = requests.post(url, headers=headers, data=data, files=files, timeout=120)
            resp.raise_for_status()
            return {"detail": f"sent to {self.display_name} (HTTP {resp.status_code})"}
        finally:
            for f in files.values():
                f.close()
