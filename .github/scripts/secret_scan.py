#!/usr/bin/env python3
"""Secret / personal-data scanner — blocks leaks into the public repo.

Pattern-based (no real secrets hardcoded here). Runs in CI and is safe to run
locally or from pre-commit. Exit code 1 on any finding. Placeholder/example
values (``<redacted>``, ``EXAMPLE``, ``your-token``, …) are allowed so docs and
sanitized samples pass.

Usage:
    python .github/scripts/secret_scan.py [path]   # default: current directory
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

# Snippets that mark a match as an intentional placeholder (allowed through).
# Keep anchored to explicit placeholder tokens — do not add broad substrings.
ALLOW = re.compile(
    r"(?i)(redacted|example|placeholder|synthetic|dummy|sample|changeme|"
    r"your[-_]?|xxxx|<[a-z0-9_.\-]+>|\$\{?[a-z_]+\}?|sk-ant-\.\.\.)"
)

# name -> compiled pattern. Each matches a *real-looking* secret or personal datum.
PATTERNS: dict[str, "re.Pattern[str]"] = {
    "Anthropic API key": re.compile(r"sk-ant-[A-Za-z0-9_-]{16,}"),
    "GitHub token (classic)": re.compile(r"\bghp_[A-Za-z0-9]{30,}"),
    "GitHub token (fine-grained)": re.compile(r"\bgithub_pat_[A-Za-z0-9_]{30,}"),
    "Slack token": re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),
    "AWS access key id": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "Google API key": re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"),
    "Private key block": re.compile(r"BEGIN (RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY"),
    "JWT / bearer token": re.compile(
        r"\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}"
    ),
    "X-API-Key value": re.compile(r"(?i)x-api-key\s*[:=]\s*[\"']?[A-Za-z0-9_\-]{16,}"),
    "TOKEN cookie value": re.compile(r"\bTOKEN=[A-Za-z0-9._\-]{16,}"),
    "hardcoded password": re.compile(
        r"(?i)\bpassword\b\s*[:=]\s*[\"'][^\"'{}<\s]{4,}[\"']"
    ),
    "personal macOS path": re.compile(r"/Users/[a-z]"),
    "personal email (gmail)": re.compile(r"[A-Za-z0-9._%+-]+@gmail\.com"),
    "private LAN IP": re.compile(r"\b(?:192\.168|10\.0\.0)\.\d{1,3}\b"),
}

SKIP_SUFFIX = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg",
    ".pdf", ".zip", ".gz", ".woff", ".woff2", ".ttf",
}
# Files that legitimately contain the patterns themselves.
SKIP_FILES = {"secret_scan.py", "test_secret_scan.py"}


def _git_files(root: Path) -> list[Path] | None:
    """Files git would commit (tracked + untracked, excluding .gitignored)."""
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-c", "-o", "--exclude-standard"],
            capture_output=True, text=True, check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return [root / line for line in out.stdout.splitlines() if line]


def _is_binary(path: Path) -> bool:
    try:
        return b"\x00" in path.read_bytes()[:2048]
    except OSError:
        return True


def iter_files(root: Path):
    files = _git_files(root)
    candidates = files if files is not None else sorted(root.rglob("*"))
    for p in candidates:
        if not p.is_file():
            continue
        if p.suffix.lower() in SKIP_SUFFIX:
            continue
        if p.name in SKIP_FILES:
            continue
        if _is_binary(p):
            continue
        yield p


def scan_text(text: str) -> list[tuple[str, str]]:
    hits: list[tuple[str, str]] = []
    for name, rx in PATTERNS.items():
        for m in rx.finditer(text):
            snippet = m.group(0)
            if ALLOW.search(snippet):
                continue
            hits.append((name, snippet[:70]))
    return hits


def main(argv: list[str]) -> int:
    root = Path(argv[1]) if len(argv) > 1 else Path()
    problems: list[tuple[Path, int, str, str]] = []
    for f in iter_files(root):
        try:
            lines = f.read_text(encoding="utf-8", errors="ignore").splitlines()
        except OSError:
            continue
        for lineno, line in enumerate(lines, 1):
            for name, snip in scan_text(line):
                problems.append((f, lineno, name, snip))

    if problems:
        print("::error::secret-scan: potential secret or personal data detected:\n",
              file=sys.stderr)
        for f, lineno, name, snip in problems:
            print(f"  {f}:{lineno}: [{name}] {snip}", file=sys.stderr)
        print("\nSanitize the value or replace it with a placeholder "
              "(example/redacted/<...>).", file=sys.stderr)
        return 1

    print("secret-scan: clean")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
