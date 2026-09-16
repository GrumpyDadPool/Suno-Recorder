r"""
Config storage split two ways, both independent of the project folder or
where the .exe happens to sit — so rebuilding the exe, moving it, or wiping
the git repo never touches saved settings:

  - Non-secret fields (folder paths, tier, artist name, IDs that aren't
    themselves credentials) -> a small JSON file in your per-user AppData
    folder (Windows: %APPDATA%\SunoDistributor\settings.json).
  - Secret fields (tokens, client secrets) -> Windows Credential Manager, via
    the `keyring` library. These never touch disk as plaintext at all —
    Windows encrypts them tied to your login. `keyring.get_password()` /
    `set_password()` are the only way in or out.

The rest of the app (core.py etc.) just calls load_settings() and gets a
single merged dict back, so nothing downstream needs to know or care which
half of a given value came from where.
"""
import json
import os
import sys
from pathlib import Path

import keyring

SERVICE_NAME = "SunoDistributor"

SECRET_FIELDS = {
    "soundcloud_client_secret",
    "soundcloud_access_token",
    "instagram_access_token",
}

NON_SECRET_FIELDS = {
    "suno_downloads_watch_folder",
    "suno_tier",
    "output_dir",
    "artist_name",
    "soundcloud_client_id",
    "instagram_business_account_id",
}

ALL_FIELDS = SECRET_FIELDS | NON_SECRET_FIELDS


def _settings_dir() -> Path:
    """Per-user app-data folder — independent of where the exe/source lives."""
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / SERVICE_NAME
    # non-Windows fallback, mainly for dev/testing this module
    return Path.home() / f".{SERVICE_NAME.lower()}"


SETTINGS_FILE = _settings_dir() / "settings.json"


def load_settings() -> dict:
    """Returns the merged config dict: non-secret fields from AppData JSON,
    secret fields from the OS credential store. Missing values come back as ''."""
    non_secrets = {}
    if SETTINGS_FILE.exists():
        non_secrets = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))

    merged = {key: non_secrets.get(key, "") for key in NON_SECRET_FIELDS}
    for key in SECRET_FIELDS:
        try:
            merged[key] = keyring.get_password(SERVICE_NAME, key) or ""
        except keyring.errors.NoKeyringError:
            # matches the save-time fallback: if there's no credential store
            # to read from, check whether the value ended up in plaintext instead
            merged[key] = non_secrets.get(key, "")

    # custom webhooks: base fields (id, name, url, auth_header_name) live in
    # the plaintext file; each webhook's auth_token comes from the credential
    # store separately, keyed by its own id (they're not a fixed set of
    # fields like SECRET_FIELDS, since the user can add any number of them)
    webhooks = []
    for wh in non_secrets.get("custom_webhooks", []):
        wh = dict(wh)
        token_key = f"webhook_token:{wh['id']}"
        try:
            wh["auth_token"] = keyring.get_password(SERVICE_NAME, token_key) or ""
        except keyring.errors.NoKeyringError:
            wh["auth_token"] = wh.get("auth_token", "")
        webhooks.append(wh)
    merged["custom_webhooks"] = webhooks

    return merged


def save_settings(cfg: dict):
    """Splits cfg and writes each half to its proper store."""
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)

    non_secrets = {key: cfg.get(key, "") for key in NON_SECRET_FIELDS}

    webhooks_for_disk = []
    for wh in cfg.get("custom_webhooks", []):
        token = wh.get("auth_token", "")
        token_key = f"webhook_token:{wh['id']}"
        try:
            if token:
                keyring.set_password(SERVICE_NAME, token_key, token)
            else:
                try:
                    keyring.delete_password(SERVICE_NAME, token_key)
                except keyring.errors.PasswordDeleteError:
                    pass
            webhooks_for_disk.append({k: v for k, v in wh.items() if k != "auth_token"})
        except keyring.errors.NoKeyringError:
            print(f"! No OS credential store available — saving the auth token for webhook "
                  f"'{wh.get('name')}' to plaintext instead. This should not happen on a normal Windows install.")
            webhooks_for_disk.append(dict(wh))  # fallback: keep auth_token inline

    non_secrets["custom_webhooks"] = webhooks_for_disk
    SETTINGS_FILE.write_text(json.dumps(non_secrets, indent=2), encoding="utf-8")

    for key in SECRET_FIELDS:
        value = cfg.get(key, "")
        try:
            if value:
                keyring.set_password(SERVICE_NAME, key, value)
            else:
                try:
                    keyring.delete_password(SERVICE_NAME, key)
                except keyring.errors.PasswordDeleteError:
                    pass  # nothing was stored for this key, nothing to delete
        except keyring.errors.NoKeyringError:
            # No OS credential backend available at all (shouldn't happen on
            # normal Windows — Credential Manager is built in). Fall back to
            # the plaintext file rather than silently losing the value, but
            # make it obvious this isn't the secure path.
            print(f"! No OS credential store available — saving '{key}' to plaintext settings file instead. "
                  f"This should not happen on a normal Windows install.")
            non_secrets[key] = value
            SETTINGS_FILE.write_text(json.dumps(non_secrets, indent=2), encoding="utf-8")


def has_settings() -> bool:
    return SETTINGS_FILE.exists()
