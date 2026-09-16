"""
Instagram's Graph API doesn't accept audio-only posts — reels need a video
container. This builds a simple static-cover-art video with your track as the
soundtrack, then publishes it as a reel via the Graph API.

Requires: an Instagram Business/Creator account linked to a Facebook Page,
and a long-lived access token with instagram_content_publish permission.
Docs: https://developers.facebook.com/docs/instagram-platform/reels-publishing
"""
import time
import requests
from pathlib import Path
from moviepy.editor import ImageClip, AudioFileClip

GRAPH_BASE = "https://graph.facebook.com/v19.0"


def build_reel_video(track_dir: Path) -> Path:
    cover = track_dir / "cover.jpg"
    audio = track_dir / "track.mp3"
    if not audio.exists():
        audio = track_dir / "track.wav"
    out_path = track_dir / "reel.mp4"

    audio_clip = AudioFileClip(str(audio))
    if cover.exists():
        image_clip = ImageClip(str(cover)).set_duration(audio_clip.duration)
    else:
        from moviepy.editor import ColorClip
        image_clip = ColorClip(size=(1080, 1080), color=(20, 20, 20)).set_duration(audio_clip.duration)

    video = image_clip.set_audio(audio_clip).resize(height=1080)
    video.write_videofile(str(out_path), fps=24, codec="libx264", audio_codec="aac", logger=None)
    return out_path


class InstagramClient:
    def __init__(self, access_token: str, business_account_id: str):
        if not access_token or not business_account_id:
            raise ValueError("instagram_access_token / instagram_business_account_id required — see README")
        self.token = access_token
        self.account_id = business_account_id

    def publish_reel(self, video_url: str, caption: str) -> dict:
        """
        video_url must be a publicly reachable URL (Graph API pulls from it,
        it can't take a raw file upload). Host the mp4 somewhere reachable
        first — see README note on hosting.
        """
        create_resp = requests.post(
            f"{GRAPH_BASE}/{self.account_id}/media",
            data={
                "media_type": "REELS",
                "video_url": video_url,
                "caption": caption,
                "access_token": self.token,
            },
            timeout=60,
        )
        create_resp.raise_for_status()
        creation_id = create_resp.json()["id"]

        for _ in range(30):
            status = requests.get(
                f"{GRAPH_BASE}/{creation_id}",
                params={"fields": "status_code", "access_token": self.token},
                timeout=30,
            ).json()
            if status.get("status_code") == "FINISHED":
                break
            time.sleep(5)

        publish_resp = requests.post(
            f"{GRAPH_BASE}/{self.account_id}/media_publish",
            data={"creation_id": creation_id, "access_token": self.token},
            timeout=60,
        )
        publish_resp.raise_for_status()
        return publish_resp.json()
