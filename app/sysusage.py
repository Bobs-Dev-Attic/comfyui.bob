"""The machine's load right now, for V2's top row: CPU %, memory %, and the GPU's use % and memory % (nvidia-smi).
No extra packages: on Windows the CPU and memory come from the kernel (GetSystemTimes, GlobalMemoryStatusEx), on
Linux from /proc. A value that can't be read is None. Readings are kept for a second, so many open pages share them."""
from __future__ import annotations

import ctypes
import shutil
import subprocess
import sys
import threading
import time
from typing import Any

_lock = threading.Lock()
_last: dict[str, Any] = {"at": 0.0, "value": None}
_cpu_prev: tuple[int, int] | None = None  # (idle, total) at the last reading


def _cpu_times() -> tuple[int, int] | None:
    """(idle, total) CPU time since boot, in any unit."""
    try:
        if sys.platform == "win32":
            ft = [ctypes.c_ulonglong() for _ in range(3)]  # idle, kernel (includes idle), user
            if not ctypes.windll.kernel32.GetSystemTimes(*(ctypes.byref(x) for x in ft)):
                return None
            idle, kernel, user = (x.value for x in ft)
            return idle, kernel + user
        with open("/proc/stat", encoding="ascii") as f:
            v = [int(x) for x in f.readline().split()[1:]]
        return v[3] + (v[4] if len(v) > 4 else 0), sum(v)
    except (OSError, ValueError, AttributeError):
        return None


def _cpu() -> float | None:
    global _cpu_prev
    now = _cpu_times()
    if not now:
        return None
    prev, _cpu_prev = _cpu_prev, now
    if not prev:  # the first reading: measure over a short moment
        time.sleep(0.25)
        prev, now = now, _cpu_times()
        _cpu_prev = now
        if not now:
            return None
    di, dt = now[0] - prev[0], now[1] - prev[1]
    return round(100 * (1 - di / dt), 1) if dt > 0 else None


def _memory() -> dict[str, float] | None:
    try:
        if sys.platform == "win32":
            class MS(ctypes.Structure):
                _fields_ = [("len", ctypes.c_ulong), ("load", ctypes.c_ulong), ("total", ctypes.c_ulonglong),
                            ("avail", ctypes.c_ulonglong), ("pt", ctypes.c_ulonglong), ("pa", ctypes.c_ulonglong),
                            ("vt", ctypes.c_ulonglong), ("va", ctypes.c_ulonglong), ("ve", ctypes.c_ulonglong)]
            m = MS(); m.len = ctypes.sizeof(MS)
            if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):
                return None
            total, avail = m.total, m.avail
        else:
            info = {}
            with open("/proc/meminfo", encoding="ascii") as f:
                for line in f:
                    k, v = line.split(":", 1)
                    info[k] = int(v.split()[0]) * 1024
            total, avail = info["MemTotal"], info.get("MemAvailable", info.get("MemFree", 0))
        return {"pct": round(100 * (total - avail) / total, 1), "used": total - avail, "total": total}
    except (OSError, ValueError, KeyError, AttributeError, ZeroDivisionError):
        return None


def _gpu() -> dict[str, Any] | None:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        out = subprocess.run(
            [exe, "--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5, check=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout.strip().splitlines()[0]
        name, util, used, total = (p.strip() for p in out.split(","))
        used_b, total_b = float(used) * 1024 ** 2, float(total) * 1024 ** 2
        return {"name": name, "pct": float(util), "mem_pct": round(100 * used_b / total_b, 1) if total_b else None,
                "mem_used": used_b, "mem_total": total_b}
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return None


def usage() -> dict[str, Any]:
    with _lock:
        if _last["value"] and time.monotonic() - _last["at"] < 1.0:
            return _last["value"]
        v = {"cpu": _cpu(), "memory": _memory(), "gpu": _gpu()}
        _last.update(at=time.monotonic(), value=v)
        return v
