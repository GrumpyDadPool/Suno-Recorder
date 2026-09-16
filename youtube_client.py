"""
Unlike Spotify/Apple, YouTube has a real public API for uploading to your own
channel — this is the most automatable monetization path we have (YouTube
Partner Program ad revenue, no distributor middleman, no revenue share back
to Suno).

Setup:
  1. In Google Cloud Console, create a project, enable "YouTube Data API v3"
  2. Create an OAuth Client ID (type: Desktop app), download as client_secret.json
     into this folder
  3. First run will open a browser for you to authorize your own channel;
     after that a token.json is cached locally so it won't ask again

Note on monetization: uploading via API doesn't by itself enroll a video in
the YouTube Partner Program — that's a channel-level program you apply to
separately in YouTube Studio. This script just gets tracks onto your channel
correctly labeled; ad revenue eligibility is a one-time channel setup step,
not something this tool needs to touch per-upload.

Note on the synthetic-media disclosure field: YouTube's policy targets
content a viewer could mistake for real footage of real people/events —
that's aimed more at things like AI-generated faces or altered video than a
static cover-art image with an AI instrumental behind it. We still expose
`contains_synthetic_media` here and default it to True so the choice is
explicit and honest rather than silently defaulting to "no," per your
disclosure preference — flip it per-video if you disagree with YouTube's
guidance for a specific track.
"""
from pathlib import Path

from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from moviepy.editor import ImageClip, AudioFileClip, ColorClip

SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]
TOKEN_FILE = Path("token.json")
CLIENT_SECRET_FILE = Path("client_secret.json")
MUSIC_CATEGORY_ID = "10"


def build_video_for_youtube(track_dir: Path) -> Path:
    """Static cover-art video with the track as audio, landscape for YouTube."""
    cover = track_dir / "cover.jpg"
    audio = track_dir / "track.wav"
    if not audio.exists():
        audio = track_dir / "track.mp3"
    out_path = track_dir / "youtube.mp4"

    audio_clip = AudioFileClip(str(audio))
    if cover.exists():
        image_clip = ImageClip(str(cover)).set_duration(audio_clip.duration)
    else:
        image_clip = ColorClip(size=(1920, 1080), color=(20, 20, 20)).set_duration(audio_clip.duration)

    video = image_clip.set_audio(audio_clip).resize(height=1080)
    video.write_videofile(str(out_path), fps=24, codec="libx264", audio_codec="aac", logger=None)
    return out_path


class YouTubeClient:
    def __init__(self):
        if not CLIENT_SECRET_FILE.exists():
            raise FileNotFoundError(
                "client_secret.json not found — download an OAuth Desktop client from "
                "Google Cloud Console (YouTube Data API v3 enabled) and place it here"
            )
        creds = None
        if TOKEN_FILE.exists():
            creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)
        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
            else:
                flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_SECRET_FILE), SCOPES)
                creds = flow.run_local_server(port=0)
            TOKEN_FILE.write_text(creds.to_json(), encoding="utf-8")
        self.youtube = build("youtube", "v3", credentials=creds)

    def upload_track(
        self,
        track_dir: Path,
        metadata: dict,
        privacy_status: str = "private",
        contains_synthetic_media: bool = True,
        ai_disclosure: bool = True,
    ) -> dict:
        video_path = track_dir / "youtube.mp4"
        if not video_path.exists():
            video_path = build_video_for_youtube(track_dir)

        title = metadata.get("title", "Untitled")
        description = metadata.get("style_tags", "")
        if ai_disclosure:
            description = (description + "\n\nMade with Suno AI. Music and cover art are AI-generated.").strip()

        tags = [t.strip() for t in metadata.get("style_tags", "").split(",") if t.strip()]

        body = {
            "snippet": {
                "title": title,
                "description": description,
                "tags": tags,
                "categoryId": MUSIC_CATEGORY_ID,
            },
            "status": {
                "privacyStatus": privacy_status,  # "private" | "unlisted" | "public"
                "selfDeclaredMadeForKids": False,
                "containsSyntheticMedia": contains_synthetic_media,
            },
        }

        media = MediaFileUpload(str(video_path), chunksize=-1, resumable=True, mimetype="video/mp4")
        request = self.youtube.videos().insert(part="snippet,status", body=body, media_body=media)

        response = None
        while response is None:
            status, response = request.next_chunk()
            if status:
                print(f"  uploading {title}: {int(status.progress() * 100)}%")

        return response
