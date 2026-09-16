"""
One canonical way to turn a track title into a safe folder name, used
everywhere that happens (suno_watcher.py, capture/segment_splitter.py, and
anywhere skip/resume logic needs to compare a raw title against an existing
output/ folder name) — so they can never drift apart and cause mismatches.
"""
import re


def sanitize_title(title: str, fallback: str = "untitled") -> str:
    cleaned = re.sub(r"[^\w\- ]", "", title or "").strip()
    return cleaned or fallback
