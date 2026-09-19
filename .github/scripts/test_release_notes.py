#!/usr/bin/env python3
"""Self-test for release_notes.py — what a release's notes carry when a cut
was skipped for one or more version bumps in a row.

Its value is entirely in the accumulation and in where the boundary comes
from: a script that only ever answered with the top changelog section would
silently drop every bump that got superseded before its own cut, and a
boundary trusted from elsewhere without checking it is actually listed here
would drop just the same way whenever that other source names a version this
changelog never had a section for.

Run: python3 .github/scripts/test_release_notes.py
"""

from __future__ import annotations

import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import release_notes  # noqa: E402

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


def run(tmp: pathlib.Path, is_released, *args: str) -> int:
    return release_notes.main(list(args), is_released=is_released)


with tempfile.TemporaryDirectory() as raw:
    tmp = pathlib.Path(raw)
    config = tmp / "config.yaml"
    changelog = tmp / "CHANGELOG.md"
    config.write_text(CONFIG)
    changelog.write_text(CHANGELOG)

    print("version reads config.yaml")
    check("value", release_notes.parse_config_version(CONFIG), "1.60.1")

    print("version refuses a file with none")
    check("no version line", release_notes.parse_config_version("name: X\n"), None)

    print("notes walks the changelog itself and stops at the first real release")
    out = tmp / "notes.md"
    seen = []

    def released_only_1595(version: str) -> bool:
        seen.append(version)
        return version == "1.59.5"

    code = run(tmp, released_only_1595, "notes", str(config), str(changelog), "--write", str(out))
    check("exit code", code, 0)
    body = out.read_text()
    check("carries the second bump", "Second bump of the day" in body, True)
    check("carries the first bump", "First bump of the day" in body, True)
    check("stops at the released version", "Already released" in body, False)
    check("asked about 1.60.1 before 1.60.0", seen[:2], ["1.60.1", "1.60.0"])
    check("never asked about the already-released version", "1.59.5" not in seen[:2], True)

    print("notes never trusts a boundary this changelog does not list")
    # a phantom version — the shape of a real risk: `gh release list` sorts by
    # created_at and does not exclude drafts/prereleases, so it can name a
    # version no changelog section was ever written for.
    out2 = tmp / "notes-phantom.md"
    code2 = run(tmp, lambda v: False, "notes", str(config), str(changelog), "--write", str(out2))
    check("exit code", code2, 0)
    body2 = out2.read_text()
    check("still carries the second bump", "Second bump of the day" in body2, True)
    check("still carries the first bump", "First bump of the day" in body2, True)
    check("still carries the oldest section (nothing is ever released)", "Already released" in body2, True)

    print("notes refuses a config version the changelog never mentions")
    config_ghost = tmp / "config-ghost.yaml"
    config_ghost.write_text('name: "X"\nversion: "9.9.9"\n')
    out3 = tmp / "notes-mismatch.md"
    code3 = run(tmp, lambda v: False, "notes", str(config_ghost), str(changelog), "--write", str(out3))
    check("exit code", code3, 1)

    print("nothing pending (config version already has a release) refuses too")
    out4 = tmp / "notes-none-pending.md"
    code4 = run(tmp, lambda v: True, "notes", str(config), str(changelog), "--write", str(out4))
    check("exit code", code4, 1)

print(f"\n{'FAILED' if fails else 'ok'} — {fails} failing check(s)")
sys.exit(1 if fails else 0)
