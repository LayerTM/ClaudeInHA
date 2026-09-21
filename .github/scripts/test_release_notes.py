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

import datetime
import os
import pathlib
import subprocess
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


def fake_gh(bin_dir: pathlib.Path, exit_code: int, stderr: str) -> None:
    """A `gh` on PATH that answers `release view` with the given exit and stderr."""
    script = bin_dir / "gh"
    script.write_text(f"#!/bin/sh\nprintf '%s\\n' '{stderr}' >&2\nexit {exit_code}\n")
    script.chmod(0o755)


def real_gh_run(tmp: pathlib.Path, bin_dir: pathlib.Path, *args: str) -> int:
    """release_notes.main with its own gh lookup, gh being the fake in bin_dir."""
    saved = os.environ["PATH"]
    os.environ["PATH"] = f"{bin_dir}{os.pathsep}{saved}"
    try:
        return release_notes.main(list(args))
    finally:
        os.environ["PATH"] = saved


with tempfile.TemporaryDirectory() as raw:
    tmp = pathlib.Path(raw)
    bin_dir = tmp / "bin"
    bin_dir.mkdir()
    config = tmp / "config.yaml"
    changelog = tmp / "CHANGELOG.md"
    config.write_text(CONFIG)
    changelog.write_text(CHANGELOG)

    print("a gh that is broken is an error, never 'no release yet'")
    # gh exits 1 for a missing release AND for a 401 or a refused connection,
    # so each broken shape below must be told apart from "release not found".
    for label, code, err in [
        ("bad token (exit 1)", 1, 'non-200 OK status code: 401 Unauthorized body: "Bad credentials"'),
        ("no network (exit 1)", 1, 'Get "https://api.github.com/x": connect: connection refused'),
        ("tool failure (exit 3)", 3, "something else went wrong"),
        ("silent failure (exit 3, no stderr)", 3, ""),
    ]:
        fake_gh(bin_dir, code, err)
        notes_out = tmp / "notes-broken.md"
        notes_out.unlink(missing_ok=True)
        check(f"notes fails: {label}", real_gh_run(tmp, bin_dir, "notes", str(config), str(changelog), "--write", str(notes_out)), 2)
        check(f"no notes written: {label}", notes_out.exists(), False)
        check(f"released says lookup failed: {label}", real_gh_run(tmp, bin_dir, "released", "1.60.1"), 2)

    print("gh's own answers still map to yes and no")
    fake_gh(bin_dir, 1, "release not found")
    check("release not found -> not released (exit 1)", real_gh_run(tmp, bin_dir, "released", "1.60.1"), 1)
    fake_gh(bin_dir, 0, "")
    check("release exists -> released (exit 0)", real_gh_run(tmp, bin_dir, "released", "1.60.1"), 0)

    print("notes through the real lookup, gh saying 'not found' for the two newest and 'exists' for the last")
    (bin_dir / "gh").write_text(
        "#!/bin/sh\n"
        'case "$3" in v1.59.5) exit 0;; *) echo "release not found" >&2; exit 1;; esac\n'
    )
    (bin_dir / "gh").chmod(0o755)
    notes_ok = tmp / "notes-ok.md"
    check("exit code", real_gh_run(tmp, bin_dir, "notes", str(config), str(changelog), "--write", str(notes_ok)), 0)
    check("carries both pending sections", ("Second bump" in notes_ok.read_text()) and ("First bump" in notes_ok.read_text()), True)
    check("stops at the released one", "Already released" in notes_ok.read_text(), False)

with tempfile.TemporaryDirectory() as raw:
    repo = pathlib.Path(raw)

    def git(*args: str, date: str | None = None) -> None:
        env = dict(os.environ)
        if date:
            env["GIT_COMMITTER_DATE"] = date
            env["GIT_AUTHOR_DATE"] = date
        subprocess.run(
            ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", *args],
            cwd=repo, env=env, check=True, capture_output=True,
        )

    git("init", "-q")
    cfg = repo / "config.yaml"
    cfg.write_text('name: "X"\nversion: "1.60.0"\n')
    git("add", ".")
    git("commit", "-q", "-m", "first", date="2026-09-01T10:00:00Z")
    cfg.write_text('name: "X"\nversion: "1.60.1"\n')
    git("commit", "-qam", "bump", date="2026-09-02T10:00:00Z")
    cfg.write_text('name: "Y"\nversion: "1.60.1"\n')
    git("commit", "-qam", "unrelated edit after the bump", date="2026-09-03T10:00:00Z")

    print("pending-since names the commit that put the version there, not the last edit")
    bump_time = int(datetime.datetime(2026, 9, 2, 10, tzinfo=datetime.timezone.utc).timestamp())
    check("time of the bump", release_notes.pending_since(cfg), bump_time)
    check("command exits 0", release_notes.main(["pending-since", str(cfg)]), 0)
    cfg.write_text('name: "Y"\nversion: "1.99.0"\n')
    check("a version git never committed has no time", release_notes.pending_since(cfg), None)
    check("and the command exits 1", release_notes.main(["pending-since", str(cfg)]), 1)

print(f"\n{'FAILED' if fails else 'ok'} — {fails} failing check(s)")
sys.exit(1 if fails else 0)
