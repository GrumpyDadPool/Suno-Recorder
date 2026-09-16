import argparse

import core


def cmd_watch(cfg, args):
    print("Watching for Suno downloads. Press Ctrl+C to stop.")
    try:
        core.watch_suno_downloads(cfg)
    except KeyboardInterrupt:
        print("\nStopped.")


def cmd_capture(cfg, args):
    print(
        "DEPRECATED: prefer the Chrome extension in chrome_extension/ (Suno Recorder).\n"
        "This Playwright + loopback path remains for compatibility only — see capture/DEPRECATED.md.\n"
    )
    print(
        "Opening a browser to play through your Suno library. This takes as long "
        "as your library's total playtime — it's real-time audio capture, there's "
        "no way to speed it up without distorting the audio. Press Ctrl+C to stop early."
    )
    try:
        core.capture_suno_library(cfg)
    except KeyboardInterrupt:
        print("\nStopped — whatever was captured before stopping still got split and saved.")


def cmd_list_platforms(cfg, args):
    platforms = core.list_available_platforms(cfg)
    print("Available platforms:")
    for platform_id, plugin in sorted(platforms.items(), key=lambda kv: kv[1].display_name):
        configured = "configured" if plugin.is_configured(cfg) else "not configured — check Settings"
        print(f"  {platform_id:20s} {plugin.display_name} ({configured})")


def cmd_distribute(cfg, args):
    all_tracks = core.list_track_dirs(cfg)
    if args.all:
        track_dirs = all_tracks
    elif args.track:
        track_dirs = [d for d in all_tracks if args.track.lower() in d.name.lower()]
        if not track_dirs:
            raise SystemExit(f"No track matching '{args.track}' found — run 'watch' and download it first")
    else:
        raise SystemExit("Specify --track <name> or --all")

    platforms = args.platforms.split(",")
    core.distribute_tracks(cfg, track_dirs, platforms, youtube_privacy=args.youtube_privacy)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Suno -> SoundCloud / YouTube / Instagram / Spotify-prep / custom webhooks")
    sub = parser.add_subparsers(dest="command", required=True)

    watch = sub.add_parser(
        "watch",
        help="Watch your downloads folder and auto-organize Suno tracks as you download them manually",
    )

    sub.add_parser(
        "capture",
        help="DEPRECATED — use chrome_extension/ (Suno Recorder). Legacy Playwright + "
             "loopback capture of your Suno library",
    )

    sub.add_parser("list-platforms", help="Show every platform currently available (built-in + custom webhooks)")

    dist = sub.add_parser("distribute", help="Push tracks to platforms")
    dist.add_argument("--track", help="Substring match on track name")
    dist.add_argument("--all", action="store_true", help="Distribute every track not yet pushed")
    dist.add_argument("--platforms", required=True,
                       help="Comma-separated platform ids — run 'list-platforms' to see what's available "
                            "(built-ins like soundcloud,youtube,instagram,spotify-prep, plus any custom "
                            "webhook ids like webhook:abc123)")
    dist.add_argument("--youtube-privacy", default="private", choices=["private", "unlisted", "public"],
                       help="Defaults to private so you can review before it goes live")

    args = parser.parse_args()
    cfg = core.load_config()

    if args.command == "watch":
        cmd_watch(cfg, args)
    elif args.command == "capture":
        cmd_capture(cfg, args)
    elif args.command == "list-platforms":
        cmd_list_platforms(cfg, args)
    elif args.command == "distribute":
        cmd_distribute(cfg, args)
