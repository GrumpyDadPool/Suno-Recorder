"""
Simple local GUI over the same core.py logic main.py uses — nothing here
talks to any service directly, it's all core.watch_suno_downloads /
core.distribute_tracks. Run with: python gui.py
"""
import queue
import threading
import tkinter as tk
from tkinter import ttk, messagebox

import core
from settings_dialog import SettingsWindow


class SunoDistributorGUI(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Suno Distributor")
        self.geometry("760x580")
        self.log_queue = queue.Queue()
        self.cfg = None
        self.watch_stop_event = None
        self.watch_thread = None
        self.capture_stop_event = None
        self.capture_thread = None

        self._build_layout()
        self._load_config()
        self._poll_log_queue()
        self.protocol("WM_DELETE_WINDOW", self.on_close)

    # ---------- layout ----------

    def _build_layout(self):
        top = ttk.Frame(self, padding=10)
        top.pack(fill="x")

        self.watch_button = ttk.Button(top, text="Start Watching for Suno Downloads", command=self.toggle_watch)
        self.watch_button.pack(side="left")

        self.watch_status = ttk.Label(top, text="Not watching")
        self.watch_status.pack(side="left", padx=10)

        self.capture_button = ttk.Button(
            top,
            text="Legacy capture (deprecated)",
            command=self.start_capture,
        )
        self.capture_button.pack(side="left", padx=(10, 0))

        ttk.Button(top, text="Settings", command=self.open_settings).pack(side="right")

        # main split: track list (left) + platforms/actions (right)
        middle = ttk.Frame(self, padding=(10, 0))
        middle.pack(fill="both", expand=True)

        left = ttk.Frame(middle)
        left.pack(side="left", fill="both", expand=True)
        ttk.Label(left, text="Tracks in output/").pack(anchor="w")
        self.track_list = tk.Listbox(left, selectmode="extended")
        self.track_list.pack(fill="both", expand=True)
        ttk.Button(left, text="Refresh list", command=self.refresh_tracks).pack(fill="x", pady=(4, 0))

        right = ttk.Frame(middle, padding=(10, 0))
        right.pack(side="left", fill="y")

        ttk.Label(right, text="Platforms").pack(anchor="w")
        self.platform_vars = {}
        self.platform_checkbox_frame = ttk.Frame(right)
        self.platform_checkbox_frame.pack(fill="x")

        ttk.Label(right, text="YouTube visibility").pack(anchor="w", pady=(10, 0))
        self.youtube_privacy = tk.StringVar(value="private")
        ttk.Combobox(right, textvariable=self.youtube_privacy,
                     values=["private", "unlisted", "public"], state="readonly", width=12).pack(anchor="w")

        ttk.Button(right, text="Distribute Selected", command=self.on_distribute_selected).pack(fill="x", pady=(15, 2))
        ttk.Button(right, text="Distribute All Undistributed", command=self.on_distribute_all).pack(fill="x")

        bottom = ttk.Frame(self, padding=10)
        bottom.pack(fill="both", expand=False)
        ttk.Label(bottom, text="Log").pack(anchor="w")
        self.log_text = tk.Text(bottom, height=14, state="disabled", wrap="word")
        self.log_text.pack(fill="both", expand=True)

    # ---------- config / track list ----------

    def _load_config(self):
        try:
            self.cfg = core.load_config()
            self.log("Config loaded.")
            if not self.cfg.get("suno_downloads_watch_folder"):
                self.log("! suno_downloads_watch_folder not set — open Settings to configure it.")
            self._rebuild_platform_checkboxes()
            self.refresh_tracks()
        except FileNotFoundError:
            self.log("No saved settings found — opening Settings to set them up.")
            self.open_settings(first_run=True)

    def _rebuild_platform_checkboxes(self):
        """Platforms shown here are whatever's currently available — built-ins
        plus any custom webhooks configured in Settings — so adding one there
        makes it show up here with no other change needed."""
        for widget in self.platform_checkbox_frame.winfo_children():
            widget.destroy()
        self.platform_vars = {}

        platforms = core.list_available_platforms(self.cfg or {})
        for platform_id, plugin in sorted(platforms.items(), key=lambda kv: kv[1].display_name):
            var = tk.BooleanVar(value=(platform_id == "soundcloud"))
            self.platform_vars[platform_id] = var
            ttk.Checkbutton(self.platform_checkbox_frame, text=plugin.display_name, variable=var).pack(anchor="w")

    def open_settings(self, first_run: bool = False):
        SettingsWindow(self, on_saved=self._on_settings_saved)

    def _on_settings_saved(self, cfg: dict):
        self.cfg = cfg
        self.log("Settings updated.")
        self._rebuild_platform_checkboxes()
        self.refresh_tracks()

    def refresh_tracks(self):
        if not self.cfg:
            return
        self.track_list.delete(0, "end")
        for track_dir in core.list_track_dirs(self.cfg):
            self.track_list.insert("end", track_dir.name)

    # ---------- logging (thread-safe: workers push to queue, UI thread drains it) ----------

    def log(self, message: str):
        self.log_queue.put(message)

    def _poll_log_queue(self):
        try:
            while True:
                message = self.log_queue.get_nowait()
                self.log_text.configure(state="normal")
                self.log_text.insert("end", message + "\n")
                self.log_text.see("end")
                self.log_text.configure(state="disabled")
                if message.startswith("  organized:"):
                    self.refresh_tracks()
        except queue.Empty:
            pass
        self.after(150, self._poll_log_queue)

    # ---------- watch toggle ----------

    def toggle_watch(self):
        if self.watch_thread and self.watch_thread.is_alive():
            self.watch_stop_event.set()
            self.watch_button.config(text="Start Watching for Suno Downloads")
            self.watch_status.config(text="Stopping...")
            return

        if not self.cfg or not self.cfg.get("suno_downloads_watch_folder"):
            messagebox.showerror("Missing config", "Set your Suno downloads folder in Settings first.")
            return

        self.watch_stop_event = threading.Event()

        def worker():
            try:
                core.watch_suno_downloads(self.cfg, stop_event=self.watch_stop_event, log=self.log)
            except Exception as e:
                self.log(f"Watcher stopped with error: {e}")
            self.watch_status.config(text="Not watching")

        self.watch_thread = threading.Thread(target=worker, daemon=True)
        self.watch_thread.start()
        self.watch_button.config(text="Stop Watching")
        self.watch_status.config(text=f"Watching {self.cfg['suno_downloads_watch_folder']}")

    def on_close(self):
        if self.watch_stop_event:
            self.watch_stop_event.set()
        if self.capture_stop_event:
            self.capture_stop_event.set()
        self.destroy()

    # ---------- capture (play-through recording) ----------

    def start_capture(self):
        if self.capture_thread and self.capture_thread.is_alive():
            self.capture_stop_event.set()
            self.capture_button.config(text="Stopping capture...")
            return

        if not messagebox.askyesno(
            "Legacy capture (deprecated)",
            "Prefer Suno Recorder: load chrome_extension/ in Chrome "
            "(silent tab capture, your normal login).\n\n"
            "Continue with the old Playwright + loopback path anyway?\n"
            "Speakers will play audio out loud during recording.",
        ):
            return

        self.capture_stop_event = threading.Event()

        def worker():
            try:
                core.capture_suno_library(self.cfg, stop_event=self.capture_stop_event, log=self.log)
            except Exception as e:
                self.log(f"Capture stopped with error: {e}")
            self.capture_button.config(text="Legacy capture (deprecated)")
            self.refresh_tracks()

        self.capture_thread = threading.Thread(target=worker, daemon=True)
        self.capture_thread.start()
        self.capture_button.config(text="Stop Capture")

    # ---------- distribute actions ----------

    def _run_distribute(self, track_dirs):
        if not track_dirs:
            messagebox.showinfo("Nothing selected", "Select at least one track, or download something from Suno first.")
            return
        platforms = [p for p, var in self.platform_vars.items() if var.get()]
        if not platforms:
            messagebox.showinfo("No platforms", "Check at least one platform.")
            return

        def worker():
            core.distribute_tracks(
                self.cfg, track_dirs, platforms,
                youtube_privacy=self.youtube_privacy.get(), log=self.log
            )
            self.log("Distribution pass complete.")

        threading.Thread(target=worker, daemon=True).start()

    def on_distribute_selected(self):
        all_tracks = {d.name: d for d in core.list_track_dirs(self.cfg)}
        selected_names = [self.track_list.get(i) for i in self.track_list.curselection()]
        track_dirs = [all_tracks[name] for name in selected_names if name in all_tracks]
        self._run_distribute(track_dirs)

    def on_distribute_all(self):
        self._run_distribute(core.list_track_dirs(self.cfg))


if __name__ == "__main__":
    app = SunoDistributorGUI()
    app.mainloop()
