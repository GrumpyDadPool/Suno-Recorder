"""
Every distribution platform — built-in or custom — implements this same
interface. That's what makes both extensibility paths work:

  - Code plugins: drop a new .py file in this folder with a class that
    subclasses PlatformPlugin (is_custom left as False). It's auto-discovered,
    no registration step needed — see registry.py.
  - No-code webhooks: WebhookPlugin (is_custom=True) is instantiated once per
    user-configured webhook from Settings, at runtime, from data rather than
    a file — see webhook_plugin.py and registry.py.

core.py's distribute_tracks() only ever talks to this interface, so it
doesn't need to know or care which kind of plugin it's calling.
"""
from abc import ABC, abstractmethod
from pathlib import Path


class ConfigField:
    """Describes one settings field a built-in plugin needs, for the Settings UI to render."""
    def __init__(self, key: str, label: str, kind: str = "text", choices=None):
        self.key = key
        self.label = label
        self.kind = kind  # "text" | "secret" | "folder" | "choice"
        self.choices = choices


class PlatformPlugin(ABC):
    platform_id: str = None      # unique key used in --platforms and state.json, e.g. "soundcloud"
    display_name: str = None     # shown in the GUI/CLI
    is_custom: bool = False      # True only for runtime-created plugins like webhooks

    @abstractmethod
    def is_configured(self, cfg: dict) -> bool:
        """Whether this plugin has what it needs to run, given the merged settings dict."""
        raise NotImplementedError

    @abstractmethod
    def upload(self, track_dir: Path, metadata: dict, cfg: dict, **kwargs) -> dict:
        """
        Perform the upload/prep. Returns a dict with at least 'detail' (str)
        describing the result — that's what gets logged and stored in
        state.json to mark this track+platform as done.
        """
        raise NotImplementedError
