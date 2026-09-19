#!/usr/bin/env python3
"""Self-test for release_notes.py — what a release's notes carry when a cut
was skipped for one or more version bumps in a row.

Its value is entirely in the accumulation: a script that only ever answered
with the top changelog section would silently drop every bump that got
superseded before its own cut, which is exactly the failure a once-daily
release schedule can trigger.

Run: python3 .github/scripts/test_release_notes.py
"""

from __future__ import annotations

import pathlib
import subprocess
import sys
import tempfile

SCRIPT = pathlib.Path(__file__).resolve().parent / "release_notes.py"

CONFIG = 'name: "X"\nversion: "1.60.1"\n'

CHANGELOG = """# Changelog

## [1.60.1] — 2026-09-19

### Changed
- Second bump of the day.

## [1.60.0] — 2026-09-19

### Changed
- First bump of the day.

## [1.59.5] — 2026-09-18

### Changed
- Already released.
"""

fails = 0


def check(label: str, got, want) -> None:
    global fails
    if got == want:
        print(f"  ok  - {label}")
    else:
        print(f"  NOT ok - {label} (got {got!r}, want {want!r})")
        fails += 1


def run(tmp: pathlib.Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args], cwd=tmp, capture_output=True, text=True
    )


def write_fixtures(tmp: pathlib.Path) -> tuple[pathlib.Path, pathlib.Path]:
    config = tmp / "config.yaml"
    changelog = tmp / "CHANGELOG.md"
    config.write_text(CONFIG)
    changelog.write_text(CHANGELOG)
    return config, changelog


with tempfile.TemporaryDirectory() as raw:
    tmp = pathlib.Path(raw)
    config, changelog = write_fixtures(tmp)

    print("version reads config.yaml")
    done = run(tmp, "version", str(config))
    check("exit code", done.returncode, 0)
    check("stdout", done.stdout.strip(), "1.60.1")

    print("version refuses a file with none")
    (tmp / "empty.yaml").write_text("name: X\n")
    done = run(tmp, "version", str(tmp / "empty.yaml"))
    check("exit code", done.returncode, 1)
    check("says it could not parse", "Could not parse" in done.stderr, True)

    print("notes since the last real release carries both pending bumps")
    out = tmp / "notes.md"
    done = run(tmp, "notes", str(config), str(changelog), "--since", "1.59.5", "--write", str(out))
    check("exit code", done.returncode, 0)
    body = out.read_text()
    check("carries the second bump", "Second bump of the day" in body, True)
    check("carries the first bump", "First bump of the day" in body, True)
    check("stops at the released version", "Already released" in body, False)

    print("notes with no prior release ever carries every pending bump")
    out2 = tmp / "notes-first.md"
    done = run(tmp, "notes", str(config), str(changelog), "--since", "", "--write", str(out2))
    check("exit code", done.returncode, 0)
    body2 = out2.read_text()
    check("carries the second bump", "Second bump of the day" in body2, True)
    check("carries the first bump", "First bump of the day" in body2, True)
    check("carries the oldest section too", "Already released" in body2, True)

    print("notes refuses a config version that is not the top of the changelog")
    config1 = tmp / "config1.yaml"
    config1.write_text('name: "X"\nversion: "1.59.5"\n')
    done = run(tmp, "notes", str(config1), str(changelog), "--since", "1.60.1", "--write", str(tmp / "x.md"))
    check("exit code", done.returncode, 1)
    check("names the mismatch", "is not the top" in done.stderr, True)

    print("a --since version missing from the changelog falls back to the top section only")
    out3 = tmp / "notes-fallback.md"
    done = run(tmp, "notes", str(config), str(changelog), "--since", "9.9.9", "--write", str(out3))
    check("exit code", done.returncode, 0)
    body3 = out3.read_text()
    check("carries only the top bump", "Second bump of the day" in body3, True)
    check("does not carry the first bump", "First bump of the day" in body3, False)

print(f"\n{'FAILED' if fails else 'ok'} — {fails} failing check(s)")
sys.exit(1 if fails else 0)
