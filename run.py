"""Start the studio: `python run.py [--open]` (then open http://127.0.0.1:8700).

start.bat runs the system check first and then this with --open.
"""
from __future__ import annotations

import argparse
import json
import threading
import time
import urllib.request
import webbrowser

import uvicorn

from app import config


def app_url() -> str:
    host = "127.0.0.1" if config.HOST in ("0.0.0.0", "", "::") else config.HOST
    return f"http://{host}:{config.PORT}"


def running_version() -> str | None:
    """Version of a Bob Studio already answering on our port, if any."""
    try:
        with urllib.request.urlopen(app_url() + "/api/status", timeout=2) as r:
            return json.load(r).get("version") or "?"
    except (OSError, ValueError):
        return None


def open_when_ready(url: str, timeout: float = 60) -> None:
    def wait() -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if running_version():
                webbrowser.open(url)
                return
            time.sleep(0.5)
    threading.Thread(target=wait, daemon=True).start()


def main() -> None:
    ap = argparse.ArgumentParser(description="Start Bob Studio.")
    ap.add_argument("--open", action="store_true", help="open the browser once the server is up")
    args = ap.parse_args()
    url = app_url()

    version = running_version()
    if version:
        print(f"Bob Studio {version} is already running at {url}")
        if args.open:
            webbrowser.open(url)
        return

    if args.open:
        open_when_ready(url)
    print(f"Starting Bob Studio at {url} (Ctrl+C to stop)")
    uvicorn.run("app.main:app", host=config.HOST, port=config.PORT, log_level="info")


if __name__ == "__main__":
    main()
