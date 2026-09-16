"""
There is no public API for uploading directly to Spotify as an individual
artist — it has to go through a distributor (DistroKid, TuneCore, CD Baby,
ONCE, etc.), each with their own manual web upload flow. This module gets
everything distributor-ready so that step is just drag-and-drop:

  - cover art resized to the standard 3000x3000 square
  - metadata.json with the fields distributors ask for, including an
    explicit ai_generated / disclosure flag (Spotify enforces the DDEX
    AI-disclosure standard now — do not skip this)
"""
import json
from pathlib import Path
from PIL import Image


def prepare_release(track_dir: Path, artist_name: str) -> Path:
    release_dir = track_dir / "spotify_release"
    release_dir.mkdir(exist_ok=True)

    cover = track_dir / "cover.jpg"
    out_cover = release_dir / "cover_3000x3000.jpg"
    if cover.exists():
        img = Image.open(cover).convert("RGB")
        size = max(img.size)
        square = Image.new("RGB", (size, size), (0, 0, 0))
        square.paste(img, ((size - img.width) // 2, (size - img.height) // 2))
        square = square.resize((3000, 3000), Image.LANCZOS)
        square.save(out_cover, "JPEG", quality=95)
    else:
        print(f"  ! no cover.jpg found for {track_dir.name} — add art before submitting to a distributor")

    wav = track_dir / "track.wav"
    if not wav.exists():
        print(f"  ! no WAV found for {track_dir.name} — Spotify/distributors expect WAV, not MP3")

    existing_meta = {}
    meta_path = track_dir / "metadata.json"
    if meta_path.exists():
        existing_meta = json.loads(meta_path.read_text(encoding="utf-8"))

    release_meta = {
        "title": existing_meta.get("title", track_dir.name),
        "artist": artist_name,
        "genre_tags": existing_meta.get("style_tags", ""),
        "release_date": None,
        "isrc": None,
        "ai_generated": True,
        "ai_disclosure_note": "Generated using Suno AI",
        "explicit": False,
        "audio_file": "track.wav",
        "artwork_file": "cover_3000x3000.jpg",
    }
    (release_dir / "metadata.json").write_text(json.dumps(release_meta, indent=2), encoding="utf-8")

    print(f"  release package ready: {release_dir} — fill in release_date, then upload to your distributor")
    return release_dir
