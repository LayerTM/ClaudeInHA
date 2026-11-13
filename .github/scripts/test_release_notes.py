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


def text_of(path: pathlib.Path) -> str:
    """What the script wrote, or "" when it wrote nothing — a failing command
    must not stop the checks after it from being reported."""
    return path.read_text() if path.exists() else ""


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

print("the version moves only in its own release pull request")
for base, head, title, allowed in [
    ("0.3.7", "0.3.7", "Codex CLI 0.169.0", True),               # no move: any title
    ("0.3.7", "0.3.8", "Release 0.3.8", True),
    ("0.3.7", "0.3.8", "Release 0.3.8: ha-agent-core 0.15.0", True),
    ("0.3.7", "0.3.8", "  Release 0.3.8  ", True),
    ("0.3.7", "0.3.8", "Codex CLI 0.168.0", False),               # the bump that reached users unreleased
    ("0.3.7", "0.3.8", "Release 0.3.9", False),                   # a release of another version
    ("0.3.7", "0.3.8", "Release 0.3.80", False),
    ("0.3.7", "0.3.8", "Release 0.3.8.1", False),
    ("0.3.7", "0.3.8", "release 0.3.8", False),
    ("0.3.7", "0.3.8", "Prepare Release 0.3.8", False),
    ("0.3.8", "0.3.7", "Codex CLI 0.169.0", False),               # a move back is a move
    (None, "0.3.8", "Add the add-on", False),                     # no base version is a move
    (None, "0.3.8", "Release 0.3.8", True),
    ("0.3.7", None, "Release 0.3.8", False),                      # a head without a version is refused
]:
    check(f"{base} -> {head} titled {title.strip()!r}", release_notes.version_move(base, head, title) is None, allowed)

with tempfile.TemporaryDirectory() as raw:
    tmp = pathlib.Path(raw)
    base_cfg, head_cfg = tmp / "base.yaml", tmp / "head.yaml"
    base_cfg.write_text('name: "X"\nversion: "0.3.7"\n')
    head_cfg.write_text('name: "X"\nversion: "0.3.8"\n')

    log_released = tmp / "released.md"
    log_released.write_text("# Changelog\n\n## 0.3.8\n\n- Released.\n\n## 0.3.7\n\n- Older.\n")
    log_unreleased = tmp / "unreleased.md"
    log_unreleased.write_text("# Changelog\n\n## Unreleased\n\n- Pending.\n\n## 0.3.7\n\n- Older.\n")

    def cli(*args: str, changelog: pathlib.Path = log_released) -> int:
        return subprocess.run(
            [sys.executable, str(pathlib.Path(release_notes.__file__)), "version-move", *args,
             "--changelog", str(changelog)],
            capture_output=True, text=True,
        ).returncode

    print("the command a workflow runs, through its exit status")
    check("a moved version in a feature pull request exits 1", cli(str(base_cfg), str(head_cfg), "Codex CLI 0.168.0"), 1)
    check("the same move in its release pull request exits 0", cli(str(base_cfg), str(head_cfg), "Release 0.3.8"), 0)
    check("an unchanged version exits 0", cli(str(head_cfg), str(head_cfg), "Anything"), 0)
    check("a base file that does not exist is a move", cli(str(tmp / "missing.yaml"), str(head_cfg), "Anything"), 1)
    check("a release pull request still carrying Unreleased exits 1",
          cli(str(base_cfg), str(head_cfg), "Release 0.3.8", changelog=log_unreleased), 1)
    check("a pull request that does not release may carry Unreleased",
          cli(str(base_cfg), str(base_cfg), "Fix a thing", changelog=log_unreleased), 0)

print("the changelog a pull request carries: Unreleased for what is not released, renamed by the release")
LOG = "# Changelog\n\n{}## 0.3.8\n\n- Released.\n\n## 0.3.7\n\n- Older.\n"
U = "## Unreleased\n\n- Pending.\n\n"
for label, text, moved, head, allowed in [
    ("no Unreleased, no move", LOG.format(""), False, "0.3.8", True),
    ("Unreleased first, no move", LOG.format(U), False, "0.3.8", True),
    ("[Unreleased] first, no move", LOG.format("## [Unreleased]\n\n- Pending.\n\n"), False, "0.3.8", True),
    ("Unreleased below a version", LOG.format("").replace("## 0.3.7", U + "## 0.3.7"), False, "0.3.8", False),
    ("two Unreleased sections", LOG.format(U + U), False, "0.3.8", False),
    ("release renamed Unreleased to its version", LOG.format("## 0.3.9\n\n- New.\n\n"), True, "0.3.9", True),
    ("release still carrying Unreleased", LOG.format(U), True, "0.3.9", False),
    ("release whose top section is another version", LOG.format(""), True, "0.3.9", False),
    ("an 'Unreleased fixes' heading is not the Unreleased section", LOG.format("## Unreleased fixes\n\n"), False, "0.3.8", True),
]:
    check(label, release_notes.changelog_problem(text, moved, head) is None, allowed)

print("the cut refuses while an Unreleased section is left: those changes would ship unlisted")
with tempfile.TemporaryDirectory() as raw:
    tmp = pathlib.Path(raw)
    (tmp / "config.yaml").write_text('name: "X"\nversion: "0.3.9"\n')
    released_08 = lambda v: v == "0.3.8"
    (tmp / "CHANGELOG.md").write_text(LOG.format(U).replace(U, U + "## 0.3.9\n\n- New.\n\n"))
    out = tmp / "notes.md"
    code = release_notes.main(["notes", str(tmp / "config.yaml"), str(tmp / "CHANGELOG.md"), "--write", str(out)],
                              is_released=released_08)
    check("notes exit 1 with Unreleased left above the version", code, 1)
    check("and write no notes", out.exists(), False)
    (tmp / "CHANGELOG.md").write_text(LOG.format("## 0.3.9\n\n- New.\n\n"))
    code = release_notes.main(["notes", str(tmp / "config.yaml"), str(tmp / "CHANGELOG.md"), "--write", str(out)],
                              is_released=released_08)
    check("renamed by the release: notes exit 0", code, 0)
    check("and carry the version's line", "- New." in text_of(out), True)

print("a released version's changelog section is not rewritten by a pull request")
BASE_LOG = LOG.format("")
released = lambda v: v in ("0.3.8", "0.3.7")
asked: list[str] = []
def recording(v: str) -> bool:
    asked.append(v)
    return released(v)
for label, head_text, allowed in [
    ("untouched", BASE_LOG, True),
    ("a new Unreleased section above", LOG.format(U), True),
    ("a release section added above", LOG.format("## 0.3.9\n\n- New.\n\n"), True),
    ("a line added to released 0.3.8", BASE_LOG.replace("- Released.", "- Released.\n- Sneaked in."), False),
    ("a typo fixed in released 0.3.7", BASE_LOG.replace("- Older.", "- Older!"), False),
    ("released 0.3.7 removed", BASE_LOG[:BASE_LOG.index("## 0.3.7")].rstrip() + "\n", False),
]:
    check(label, release_notes.released_section_changed(BASE_LOG, head_text, released) is None, allowed)
asked.clear()
release_notes.released_section_changed(BASE_LOG, LOG.format(U), recording)
check("an untouched changelog asks GitHub nothing", asked, [])
pending_base = LOG.format("## 0.3.9\n\n- New.\n\n")
check("a section not released yet (between a release pull request and its cut) may still change",
      release_notes.released_section_changed(pending_base, pending_base.replace("- New.", "- New, fixed."), released), None)
check("the reason says how to proceed",
      "release pull request" in (release_notes.released_section_changed(BASE_LOG, BASE_LOG.replace("- Older.", "- X."), released) or ""), True)

def lookup_fails(v: str) -> bool:
    raise release_notes.ReleaseLookupError("no network")
with tempfile.TemporaryDirectory() as raw:
    tmp = pathlib.Path(raw)
    cfg = tmp / "config.yaml"; cfg.write_text('name: "X"\nversion: "0.3.8"\n')
    base_log, head_log = tmp / "base.md", tmp / "head.md"
    base_log.write_text(BASE_LOG); head_log.write_text(BASE_LOG.replace("- Older.", "- Older!"))
    argv = ["version-move", str(cfg), str(cfg), "Fix a typo", "--changelog", str(head_log), "--base-changelog", str(base_log)]
    check("command: a changed released section exits 1", release_notes.main(argv, is_released=released), 1)
    check("command: GitHub unable to say exits 2, never 0", release_notes.main(argv, is_released=lookup_fails), 2)
    head_log.write_text(BASE_LOG)
    check("command: an untouched changelog exits 0", release_notes.main(argv, is_released=lookup_fails), 0)
    head_cfg = tmp / "head-config.yaml"; head_cfg.write_text('name: "X"\nversion: "0.3.9"\n')
    head_log.write_text(LOG.format("## 0.3.9\n\n- New.\n\n").replace("- Older.", "- Older!"))
    check("command: a release pull request may correct a released section",
          release_notes.main(["version-move", str(cfg), str(head_cfg), "Release 0.3.9", "--changelog", str(head_log),
                              "--base-changelog", str(base_log)], is_released=released), 0)

print(f"\n{'FAILED' if fails else 'ok'} — {fails} failing check(s)")
sys.exit(1 if fails else 0)
