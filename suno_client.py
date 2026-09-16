"""
Suno has no public API. This talks to the same internal endpoints the Suno
Studio web app uses, authenticated with your own session token (see README).
You're only ever pulling tracks that belong to your own account.

--- Sept 3, 2026 ToS / download policy ---
Suno now caps downloads per billing month by tier (Free: 7 lifetime, Pro: 20/mo,
Premier: 60/mo, unlimited only via Suno Studio on Premier). Re-downloading a song
you already pulled (any format, or its stems) does NOT cost additional quota —
but pulling a NEW song for the first time does, once, regardless of how many
formats you grab in that pass.

More importantly: as of the new terms, commercial-use rights attach to a song
only once you've downloaded it through a permitted channel within your tier's
quota — being on a paid plan alone no longer covers your whole library. That
means quota should be spent deliberately on tracks you actually intend to
distribute, not burned on a blind "grab everything" pass.

This client tracks quota usage locally in quota_state.json and will refuse to
start a new download once you're at your monthly cap, rather than silently
eating into songs you haven't picked yet.
"""
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

BASE_URL = "https://studio-api.suno.ai/api"

TIER_QUOTAS = {
    "free": 7,        # lifetime, not monthly
    "pro": 20,        # per month
    "premier": 60,    # per month
}

QUOTA_STATE_FILE = Path("quota_state.json")


class SunoClient:
    def __init__(self, session_token: str, output_dir: str = "output", tier: str = "pro"):
        if not session_token:
            raise ValueError("suno_session_token is empty — see README setup steps")
        if tier not in TIER_QUOTAS:
            raise ValueError(f"suno_tier must be one of {list(TIER_QUOTAS)}")
        self.session = requests.Session()
        # Suno accepts either a raw cookie header or a bearer token depending
        # on how you copied it from DevTools. Try bearer first.
        self.session.headers.update({
            "Authorization": f"Bearer {session_token}",
            "Cookie": session_token,
            "User-Agent": "Mozilla/5.0",
        })
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(exist_ok=True, parents=True)
        self.tier = tier
        self.quota = self._load_quota()

    # ---- quota tracking (local estimate — Suno doesn't expose remaining count via API) ----

    def _load_quota(self) -> dict:
        if QUOTA_STATE_FILE.exists():
            state = json.loads(QUOTA_STATE_FILE.read_text(encoding="utf-8"))
        else:
            state = {"period_start": None, "downloaded_ids": [], "lifetime_downloaded_ids": []}

        if self.tier == "free":
            return state  # lifetime cap, no period reset

        now = datetime.now(timezone.utc)
        period_start = state.get("period_start")
        if not period_start or self._months_between(period_start, now) >= 1:
            state["period_start"] = now.isoformat()
            state["downloaded_ids"] = []
        return state

    @staticmethod
    def _months_between(iso_str: str, now: datetime) -> int:
        then = datetime.fromisoformat(iso_str)
        return (now.year - then.year) * 12 + (now.month - then.month)

    def _save_quota(self):
        QUOTA_STATE_FILE.write_text(json.dumps(self.quota, indent=2), encoding="utf-8")

    def remaining_quota(self) -> int:
        cap = TIER_QUOTAS[self.tier]
        if self.tier == "free":
            used = len(self.quota.get("lifetime_downloaded_ids", []))
        else:
            used = len(self.quota.get("downloaded_ids", []))
        return max(0, cap - used)

    def _record_download(self, clip_id: str):
        key = "lifetime_downloaded_ids" if self.tier == "free" else "downloaded_ids"
        ids = self.quota.setdefault(key, [])
        if clip_id not in ids:
            ids.append(clip_id)
        self._save_quota()

    def _already_downloaded(self, clip_id: str) -> bool:
        key = "lifetime_downloaded_ids" if self.tier == "free" else "downloaded_ids"
        return clip_id in self.quota.get(key, [])

    # ---- library ----

    def list_library(self, page_size: int = 50):
        """Yields track metadata dicts for every clip in your library."""
        offset = 0
        while True:
            resp = self.session.get(
                f"{BASE_URL}/feed",
                params={"page": offset // page_size, "page_size": page_size},
            )
            resp.raise_for_status()
            data = resp.json()
            clips = data.get("clips", data if isinstance(data, list) else [])
            if not clips:
                break
            for clip in clips:
                yield clip
            if len(clips) < page_size:
                break
            offset += page_size
            time.sleep(0.5)  # be polite, don't hammer an undocumented endpoint

    def download_track(self, clip: dict, formats=("wav",)) -> Path | None:
        """
        Downloads the requested formats + lyrics + metadata for one clip into
        output/<safe_title>/. Spends one unit of quota only if this clip
        hasn't been downloaded before this call. Returns None (and skips)
        if quota is exhausted and this is a new clip.
        """
        clip_id = clip.get("id")
        title = clip.get("title") or clip_id
        safe_title = "".join(c for c in title if c.isalnum() or c in " _-").strip() or clip_id
        track_dir = self.output_dir / safe_title

        is_new = not self._already_downloaded(clip_id)
        if is_new and self.remaining_quota() <= 0:
            print(f"  ! skipping '{title}' — monthly Suno download quota ({TIER_QUOTAS[self.tier]}) "
                  f"is used up. Pick your priority tracks or wait for reset / buy extra downloads.")
            return None

        track_dir.mkdir(exist_ok=True, parents=True)

        urls = {
            "wav": clip.get("audio_url_wav") or f"{BASE_URL}/gen/{clip_id}/wav",
            "mp3": clip.get("audio_url") or f"{BASE_URL}/gen/{clip_id}/mp3",
        }
        for fmt in formats:
            url = urls.get(fmt)
            if not url:
                continue
            try:
                r = self.session.get(url, timeout=60)
                if r.ok and r.content:
                    (track_dir / f"track.{fmt}").write_bytes(r.content)
            except requests.RequestException as e:
                print(f"  ! failed to fetch {fmt} for {title}: {e}")

        image_url = clip.get("image_url")
        if image_url:
            try:
                r = self.session.get(image_url, timeout=30)
                if r.ok:
                    (track_dir / "cover.jpg").write_bytes(r.content)
            except requests.RequestException:
                pass

        lyrics = clip.get("metadata", {}).get("prompt", "") or clip.get("lyric", "")
        (track_dir / "lyrics.txt").write_text(lyrics or "", encoding="utf-8")

        metadata = {
            "suno_id": clip_id,
            "title": title,
            "style_tags": clip.get("metadata", {}).get("tags", ""),
            "created_at": clip.get("created_at"),
            "ai_generated": True,
            "source": "suno",
            "commercial_rights_locked_in": True,  # true once a permitted download has occurred
        }
        (track_dir / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")

        if is_new:
            self._record_download(clip_id)
            print(f"  quota used: {len(self.quota.get('downloaded_ids' if self.tier != 'free' else 'lifetime_downloaded_ids', []))}"
                  f"/{TIER_QUOTAS[self.tier]} this period")

        return track_dir
