"""
In-app settings editor. Reads/writes through secure_config.py, which splits
values between a per-user AppData settings file (non-secret fields: folders,
tier, artist name, webhook URLs) and Windows Credential Manager (secret
fields: tokens) — neither depends on the project folder or the exe's
location, so nothing here gets wiped by rebuilding the exe, moving it, or
resetting the git repo.

Also where custom distribution points (webhooks) get added with no code —
see WebhookEditDialog. For adding a platform with code instead, see
platforms/base.py and drop a new file in platforms/.

Opens automatically on first run if nothing's been saved yet, and any time
after that via the Settings button.
"""
import uuid
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

import secure_config

FIELDS = [
    # (key, label, kind, extra)
    ("suno_downloads_watch_folder", "Suno downloads folder (your browser's download location)", "folder", None),
    ("suno_tier", "Suno tier", "choice", ["free", "pro", "premier"]),
    ("output_dir", "Output folder (organized tracks land here)", "folder", None),
    ("artist_name", "Artist name (used in Spotify release metadata)", "text", None),
    ("soundcloud_client_id", "SoundCloud client ID", "text", None),
    ("soundcloud_client_secret", "SoundCloud client secret", "secret", None),
    ("soundcloud_access_token", "SoundCloud access token", "secret", None),
    ("instagram_access_token", "Instagram access token", "secret", None),
    ("instagram_business_account_id", "Instagram business account ID", "text", None),
]


class SettingsWindow(tk.Toplevel):
    """on_saved(cfg) is called with the merged settings dict after a successful save."""

    def __init__(self, parent, on_saved=None):
        super().__init__(parent)
        self.title("Suno Distributor — Settings")
        self.geometry("600x680")
        self.on_saved = on_saved
        self.vars = {}

        merged = secure_config.load_settings()
        self.webhooks = list(merged.get("custom_webhooks", []))  # working copy, edited in memory until Save

        # scrollable container, since built-in fields + webhook list can run long
        canvas = tk.Canvas(self, highlightthickness=0)
        scrollbar = ttk.Scrollbar(self, orient="vertical", command=canvas.yview)
        container = ttk.Frame(canvas, padding=15)
        container.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.create_window((0, 0), window=container, anchor="nw")
        canvas.configure(yscrollcommand=scrollbar.set)
        canvas.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")

        ttk.Label(
            container,
            text="Saved to your Windows user profile — independent of this app's folder, "
                 "so rebuilding or moving the exe never loses these.",
            wraplength=540, foreground="#555",
        ).pack(fill="x", pady=(0, 10))

        for key, label, kind, extra in FIELDS:
            row = ttk.Frame(container)
            row.pack(fill="x", pady=4)
            ttk.Label(row, text=label, wraplength=280).pack(side="left")

            var = tk.StringVar(value=merged.get(key, ""))
            self.vars[key] = var

            if kind == "folder":
                entry = ttk.Entry(row, textvariable=var, width=22)
                entry.pack(side="right")
                ttk.Button(row, text="Browse", command=lambda v=var: self._browse_folder(v)).pack(side="right", padx=(0, 4))
            elif kind == "choice":
                ttk.Combobox(row, textvariable=var, values=extra, state="readonly", width=20).pack(side="right")
            elif kind == "secret":
                ttk.Entry(row, textvariable=var, width=25, show="•").pack(side="right")
            else:
                ttk.Entry(row, textvariable=var, width=25).pack(side="right")

        ttk.Label(
            container,
            text="Fields marked secret (SoundCloud/Instagram tokens) go into Windows Credential "
                 "Manager, encrypted to your login — never written to disk as plain text. "
                 "YouTube uses its own separate sign-in the first time you distribute to it "
                 "(needs client_secret.json next to the app — see README).",
            wraplength=540, foreground="#555",
        ).pack(fill="x", pady=(10, 0))

        # --- custom distribution points ---
        ttk.Separator(container).pack(fill="x", pady=15)
        ttk.Label(container, text="Custom Distribution Points", font=("", 10, "bold")).pack(anchor="w")
        ttk.Label(
            container,
            text="Add any platform that accepts a webhook — a direct REST endpoint, or an "
                 "automation tool like Zapier/Make/n8n that fans out to something else entirely. "
                 "Sends the track audio, cover art, and metadata as a multipart POST.",
            wraplength=540, foreground="#555",
        ).pack(fill="x", pady=(2, 8))

        self.webhook_list = tk.Listbox(container, height=5)
        self.webhook_list.pack(fill="x")
        self._refresh_webhook_list()

        webhook_buttons = ttk.Frame(container)
        webhook_buttons.pack(fill="x", pady=(4, 0))
        ttk.Button(webhook_buttons, text="Add", command=self._add_webhook).pack(side="left")
        ttk.Button(webhook_buttons, text="Edit", command=self._edit_webhook).pack(side="left", padx=4)
        ttk.Button(webhook_buttons, text="Remove", command=self._remove_webhook).pack(side="left")

        button_row = ttk.Frame(container)
        button_row.pack(fill="x", pady=(15, 0))
        ttk.Button(button_row, text="Save", command=self._save).pack(side="right")
        ttk.Button(button_row, text="Cancel", command=self.destroy).pack(side="right", padx=(0, 6))

    def _browse_folder(self, var: tk.StringVar):
        chosen = filedialog.askdirectory(initialdir=var.get() or ".")
        if chosen:
            var.set(chosen)

    # ---------- webhook list management ----------

    def _refresh_webhook_list(self):
        self.webhook_list.delete(0, "end")
        for wh in self.webhooks:
            self.webhook_list.insert("end", f"{wh.get('name', 'Unnamed')} — {wh.get('url', '')}")

    def _add_webhook(self):
        WebhookEditDialog(self, on_saved=self._on_webhook_saved)

    def _edit_webhook(self):
        selection = self.webhook_list.curselection()
        if not selection:
            messagebox.showinfo("Nothing selected", "Select a webhook to edit first.")
            return
        existing = self.webhooks[selection[0]]
        WebhookEditDialog(self, existing=existing, on_saved=self._on_webhook_saved)

    def _remove_webhook(self):
        selection = self.webhook_list.curselection()
        if not selection:
            messagebox.showinfo("Nothing selected", "Select a webhook to remove first.")
            return
        del self.webhooks[selection[0]]
        self._refresh_webhook_list()

    def _on_webhook_saved(self, webhook: dict):
        existing_ids = [wh["id"] for wh in self.webhooks]
        if webhook["id"] in existing_ids:
            self.webhooks[existing_ids.index(webhook["id"])] = webhook
        else:
            self.webhooks.append(webhook)
        self._refresh_webhook_list()

    # ---------- save ----------

    def _save(self):
        cfg = {key: var.get() for key, var in self.vars.items()}
        if not cfg.get("suno_downloads_watch_folder"):
            messagebox.showwarning("Missing folder", "Set your Suno downloads folder before saving.")
            return

        cfg["custom_webhooks"] = self.webhooks
        secure_config.save_settings(cfg)
        messagebox.showinfo("Saved", "Settings saved to your Windows user profile.")
        if self.on_saved:
            self.on_saved(cfg)
        self.destroy()


class WebhookEditDialog(tk.Toplevel):
    """Add or edit one custom webhook distribution point. on_saved(dict) fires on save."""

    def __init__(self, parent, existing: dict = None, on_saved=None):
        super().__init__(parent)
        self.title("Edit Distribution Point" if existing else "Add Distribution Point")
        self.geometry("420x260")
        self.on_saved = on_saved
        self.webhook_id = existing["id"] if existing else uuid.uuid4().hex[:12]

        container = ttk.Frame(self, padding=15)
        container.pack(fill="both", expand=True)

        self.name_var = tk.StringVar(value=(existing or {}).get("name", ""))
        self.url_var = tk.StringVar(value=(existing or {}).get("url", ""))
        self.header_var = tk.StringVar(value=(existing or {}).get("auth_header_name", "Authorization"))
        self.token_var = tk.StringVar(value=(existing or {}).get("auth_token", ""))

        for label, var, secret in [
            ("Name (e.g. 'Bandcamp via Zapier')", self.name_var, False),
            ("Webhook URL", self.url_var, False),
            ("Auth header name", self.header_var, False),
            ("Auth token / API key", self.token_var, True),
        ]:
            row = ttk.Frame(container)
            row.pack(fill="x", pady=4)
            ttk.Label(row, text=label, wraplength=160).pack(side="left")
            ttk.Entry(row, textvariable=var, width=26, show="•" if secret else "").pack(side="right")

        ttk.Label(
            container,
            text="If your auth header name is left as 'Authorization', the token is sent as "
                 "'Bearer <token>'. Change it if your endpoint expects something else "
                 "(e.g. 'X-Api-Key').",
            wraplength=390, foreground="#555",
        ).pack(fill="x", pady=(8, 0))

        button_row = ttk.Frame(container)
        button_row.pack(fill="x", pady=(15, 0))
        ttk.Button(button_row, text="Save", command=self._save).pack(side="right")
        ttk.Button(button_row, text="Cancel", command=self.destroy).pack(side="right", padx=(0, 6))

    def _save(self):
        if not self.name_var.get().strip() or not self.url_var.get().strip():
            messagebox.showwarning("Missing info", "Name and URL are both required.")
            return

        webhook = {
            "id": self.webhook_id,
            "name": self.name_var.get().strip(),
            "url": self.url_var.get().strip(),
            "auth_header_name": self.header_var.get().strip() or "Authorization",
            "auth_token": self.token_var.get(),
        }
        if self.on_saved:
            self.on_saved(webhook)
        self.destroy()
