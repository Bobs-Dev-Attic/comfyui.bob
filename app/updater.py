"""Keep this copy of Bob Studio up to date with the GitHub repository (Settings › Updates).

Every few minutes (and at startup) the studio fetches origin/main. When new commits are there, the
copy is on main with no edits of its own and nothing is rendering, it fast-forwards to them,
reinstalls the Python packages if requirements.txt changed, and restarts itself: a new run.py
starts (it waits for this one to free the port) and this one shuts down cleanly. The page sees
the new version on its next status poll and offers a reload.

It never discards anything: on another branch, with uncommitted edits to tracked files, or when
main can't fast-forward, it only reports why it stopped.
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable

from . import __version__, appsettings, config

log = logging.getLogger("bob.update")

ROOT: Path = config.ROOT
BRANCH = "main"
REMOTE = "origin"

_state: dict[str, Any] = {"version": __version__, "checked": None, "error": None, "behind": 0, "branch": None,
                          "blocked": None, "applying": False, "restarting": False, "commits": []}
_lock = asyncio.Lock()


def _git(*args: str, timeout: float = 60) -> str:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}  # never wait for a password
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    r = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, timeout=timeout, env=env,
                       creationflags=flags)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip().splitlines()[-1] if (r.stderr or r.stdout).strip()
                           else f"git {args[0]} failed")
    return r.stdout.strip()


def available() -> str | None:
    """Why updates can't work here, or None."""
    if not shutil.which("git"):
        return "Git isn't installed (or isn't on PATH), so the studio can't fetch updates."
    if not (ROOT / ".git").exists():
        return "This copy isn't a Git checkout (it was downloaded as a ZIP), so it can't update itself."
    return None


def _check_sync() -> dict[str, Any]:
    why = available()
    if why:
        return {"error": why, "behind": 0, "branch": None, "blocked": None, "commits": []}
    _git("fetch", "--quiet", REMOTE, BRANCH, timeout=90)
    branch = _git("rev-parse", "--abbrev-ref", "HEAD")
    target = f"{REMOTE}/{BRANCH}"
    behind = int(_git("rev-list", "--count", f"HEAD..{target}") or 0)
    commits = _git("log", "--format=%s", "-n", "8", f"HEAD..{target}").splitlines() if behind else []
    blocked = None
    if behind:
        if branch != BRANCH:
            blocked = f"This copy is on the branch “{branch}”, not {BRANCH}. Switch to {BRANCH} to get updates."
        elif _git("status", "--porcelain", "--untracked-files=no"):
            blocked = "This copy has edits of its own to the studio's files; updates wait until they're committed or stashed."
        else:
            try:
                _git("merge-base", "--is-ancestor", "HEAD", target)
            except RuntimeError:
                blocked = f"This copy has commits that aren't on GitHub's {BRANCH}, so it can't simply move forward."
    return {"error": None, "behind": behind, "branch": branch, "blocked": blocked, "commits": commits}


async def check() -> dict[str, Any]:
    try:
        found = await asyncio.to_thread(_check_sync)
    except (RuntimeError, subprocess.SubprocessError, OSError) as exc:
        found = {"error": f"Couldn't check for updates: {exc}", "behind": 0, "blocked": None, "commits": []}
    _state.update(found, checked=time.time())
    return status()


def status() -> dict[str, Any]:
    return {**_state, "mode": appsettings.get().updates.mode, "repo": "Bobs-Dev-Attic/comfyui.bob"}


def _apply_sync() -> str:
    before = _git("rev-parse", "HEAD")
    _git("merge", "--ff-only", "--quiet", f"{REMOTE}/{BRANCH}")
    changed = _git("diff", "--name-only", before, "HEAD").splitlines()
    if "requirements.txt" in changed:
        log.info("requirements.txt changed: installing packages")
        r = subprocess.run([sys.executable, "-m", "pip", "install", "-r", "requirements.txt", "--quiet"], cwd=ROOT,
                           capture_output=True, text=True, timeout=900,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if r.returncode != 0:
            raise RuntimeError(f"Updated the files, but installing packages failed: {(r.stderr or r.stdout).strip()[-300:]}")
        marker = ROOT / ".venv" / ".requirements-installed"  # start.bat's "packages are current" marker
        if marker.parent.exists():
            marker.touch()
    return _git("rev-parse", "--short", "HEAD")


def _restart() -> None:
    """Start a new studio (it waits for this one to free the port), then shut this one down cleanly."""
    cmd = [sys.executable, str(ROOT / "run.py"), "--after-update"]
    if os.name == "nt":
        flags = subprocess.CREATE_NEW_CONSOLE | subprocess.CREATE_NEW_PROCESS_GROUP  # its own console window
        subprocess.Popen(cmd, cwd=ROOT, creationflags=flags)
    else:
        logf = open(config.DATA_DIR / "restart.log", "ab")  # noqa: SIM115 - handed to the new process
        subprocess.Popen(cmd, cwd=ROOT, stdout=logf, stderr=logf, stdin=subprocess.DEVNULL, start_new_session=True)
    log.info("restarting for the update")
    signal.raise_signal(signal.SIGINT)  # uvicorn's own shutdown: the lifespan stops the proxy and saves state
    # If the server doesn't stop (a hung request), make sure the port frees for the new one.
    threading.Timer(20, lambda: os._exit(0)).start()


async def apply(busy: Callable[[], bool], restart: bool = True) -> dict[str, Any]:
    """Fast-forward to origin/main and restart. Raises ValueError with the reason it didn't."""
    async with _lock:
        await check()
        if _state["error"]:
            raise ValueError(_state["error"])
        if not _state["behind"]:
            raise ValueError("Already up to date.")
        if _state["blocked"]:
            raise ValueError(_state["blocked"])
        if busy():
            raise ValueError("A render is running; the update waits until it's done.")
        _state["applying"] = True
        try:
            head = await asyncio.to_thread(_apply_sync)
        except (RuntimeError, subprocess.SubprocessError, OSError) as exc:
            _state["error"] = str(exc)
            raise ValueError(str(exc)) from exc
        finally:
            _state["applying"] = False
        log.info("updated to %s", head)
        _state.update(behind=0, commits=[], restarting=restart)
        if restart:
            asyncio.get_running_loop().call_later(1.0, _restart)  # let this answer reach the page first
        return status()


async def loop(busy: Callable[[], bool]) -> None:
    """The background check: soon after startup, then every few minutes; applies in Automatic mode."""
    await asyncio.sleep(20)
    while True:
        u = appsettings.get().updates
        if u.mode != "off":
            await check()
            if u.mode == "auto" and _state["behind"] and not _state["blocked"] and not _state["error"] and not busy():
                try:
                    await apply(busy)
                    return  # restarting
                except ValueError as exc:
                    log.info("automatic update skipped: %s", exc)
        await asyncio.sleep(max(1, appsettings.get().updates.check_minutes) * 60)
