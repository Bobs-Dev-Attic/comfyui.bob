"""Fail if staged (or all tracked) files contain something that looks like a secret.

Run before every commit:  .venv\\Scripts\\python scripts\\check_secrets.py
Use --all to scan every tracked file instead of the staged changes.
"""
from __future__ import annotations

import re
import subprocess
import sys

PATTERNS = {
    "private key": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "GitHub token": re.compile(r"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b"),
    "OpenAI-style key": re.compile(r"\bsk-(proj-)?[A-Za-z0-9_-]{20,}\b"),
    "Anthropic key": re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}\b"),
    "Hugging Face token": re.compile(r"\bhf_[A-Za-z0-9]{30,}\b"),
    "AWS access key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "Google API key": re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"),
    "Slack token": re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"),
    "assigned secret": re.compile(
        r"(?i)\b[A-Z0-9_]*(API_KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*\s*[=:]\s*['\"]?[A-Za-z0-9_\-./+]{16,}"),
}
FORBIDDEN_FILES = re.compile(r"(^|/)(\.env(\..+)?|.*\.(pem|key|p12|pfx))$")
ALLOWED_FILES = {".env.example"}


def git(*args: str) -> str:
    return subprocess.run(["git", *args], capture_output=True, text=True, encoding="utf-8", check=True).stdout


def main() -> int:
    scan_all = "--all" in sys.argv
    files = git("ls-files").splitlines() if scan_all else git("diff", "--cached", "--name-only", "--diff-filter=ACM").splitlines()
    problems: list[str] = []
    for f in files:
        if FORBIDDEN_FILES.search(f) and f not in ALLOWED_FILES:
            problems.append(f"{f}: secret file type must not be committed")
            continue
        try:
            text = git("show", f":{f}") if not scan_all else open(f, encoding="utf-8", errors="ignore").read()
        except (subprocess.CalledProcessError, OSError):
            continue
        for n, line in enumerate(text.splitlines(), 1):
            for name, rx in PATTERNS.items():
                if rx.search(line):
                    problems.append(f"{f}:{n}: possible {name}")
    if problems:
        print("Possible secrets found; remove them (use .env) before committing:")
        print("\n".join("  " + p for p in problems))
        return 1
    print(f"No secrets found in {len(files)} file(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
