"""
The single place that knows how to find every available platform:

  - Built-in (and any hand-written custom) code plugins are auto-discovered
    by scanning this package's .py files for PlatformPlugin subclasses —
    dropping in a new file is enough, no registration step.
  - Custom webhooks are read from cfg['custom_webhooks'] (set via Settings)
    and turned into WebhookPlugin instances on the fly, since they're data
    rather than files.

Everything else in the app (core.py, gui.py, main.py) calls get_all_platforms()
and works with whatever comes back — it never needs to know which platforms
exist ahead of time.
"""
import importlib
import pkgutil
from pathlib import Path

from .base import PlatformPlugin
from .webhook_plugin import WebhookPlugin

_EXCLUDED_MODULES = {"base", "webhook_plugin", "registry"}

_builtin_plugin_cache = None


def _discover_code_plugins() -> dict:
    """Scans this package's modules for non-custom PlatformPlugin subclasses.
    Cached at module level so instances (and any client they lazily hold,
    like YouTube's auth) persist for the life of the process."""
    global _builtin_plugin_cache
    if _builtin_plugin_cache is not None:
        return _builtin_plugin_cache

    plugins = {}
    package_dir = Path(__file__).parent
    for _, module_name, _ in pkgutil.iter_modules([str(package_dir)]):
        if module_name in _EXCLUDED_MODULES:
            continue
        module = importlib.import_module(f"{__package__}.{module_name}")
        for attr_name in dir(module):
            attr = getattr(module, attr_name)
            if (isinstance(attr, type)
                    and issubclass(attr, PlatformPlugin)
                    and attr not in (PlatformPlugin,)
                    and not getattr(attr, "is_custom", False)):
                instance = attr()
                plugins[instance.platform_id] = instance

    _builtin_plugin_cache = plugins
    return plugins


def get_all_platforms(cfg: dict) -> dict:
    """Returns {platform_id: plugin_instance} — built-ins plus any configured custom webhooks."""
    platforms = dict(_discover_code_plugins())
    for webhook_cfg in cfg.get("custom_webhooks", []):
        plugin = WebhookPlugin(webhook_cfg)
        platforms[plugin.platform_id] = plugin
    return platforms
