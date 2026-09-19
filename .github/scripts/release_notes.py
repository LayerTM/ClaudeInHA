#!/usr/bin/env python3
"""What a release's version and notes are, for the commit CI just measured.

Releases are no longer cut on every push, so several version bumps can land
on main between two release cuts. CHANGELOG.md lists every version's own
section once, newest first — if a cut only ever took the top section, a
version bumped and superseded before its own cut would vanish from every
release's notes for good. This walks down from the top of the changelog,
asking GitHub about each version in turn, and collects every section up to
the first one that already has a release — so a release cut after N pending
bumps still carries all N of them, and the boundary is always a version this
changelog actually lists, never a guess from something else's sort order.

Commands:
  version <config.yaml>
                    print the version config.yaml declares; exit 1 if it
                    cannot be parsed.
  notes <config.yaml> <CHANGELOG.md> --write PATH
                    write the combined notes for every unreleased changelog
                    section to PATH; exit 1 if config.yaml's version is not
                    the top of that unreleased run (nothing pending, or the
                    changelog was not updated for the bump).

Run: python3 .github/scripts/release_notes.py <command> ...
"""

from __future__ import annotations

import argparse
import pathlib
import re
import subprocess
import sys
from typing import Callable

VERSION_RE = re.compile(r'^version:\s*"?(\d+\.\d+\.\d+)', re.MULTILINE)
HEADER_RE = re.compile(r"^## \[(\d+\.\d+\.\d+)\][^\n]*$", re.MULTILINE)

IsReleased = Callable[[str], bool]


def parse_config_version(text: str) -> str | None:
    """The version config.yaml declares, or None if the line is missing."""
    match = VERSION_RE.search(text)
    return match.group(1) if match else None


def parse_changelog_sections(text: str) -> list[tuple[str, str]]:
    """(version, full section text incl. header), newest first, as written."""
    headers = list(HEADER_RE.finditer(text))
    sections = []
    for i, header in enumerate(headers):
        end = headers[i + 1].start() if i + 1 < len(headers) else len(text)
        sections.append((header.group(1), text[header.start() : end].rstrip("\n")))
    return sections


def unreleased_prefix(sections: list[tuple[str, str]], is_released: IsReleased) -> list[tuple[str, str]]:
    """The leading sections whose version has no release yet.

    Asks `is_released` about each version in changelog order and stops at the
    first one it confirms — the boundary this returns is always a version the
    changelog actually lists, never a version guessed from somewhere else
    (a release listing's sort order, say) that might not appear here at all.
    """
    result = []
    for version, body in sections:
        if is_released(version):
            break
        result.append((version, body))
    return result


def render_notes(sections: list[tuple[str, str]]) -> str:
    if not sections:
        return ""
    return "\n\n".join(body for _, body in sections) + "\n"


def gh_release_exists(version: str) -> bool:
    result = subprocess.run(
        ["gh", "release", "view", f"v{version}"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0


def cmd_version(args: argparse.Namespace) -> int:
    version = parse_config_version(pathlib.Path(args.config).read_text(encoding="utf-8"))
    if not version:
        print(f"Could not parse version from {args.config}", file=sys.stderr)
        return 1
    print(version)
    return 0


def cmd_notes(args: argparse.Namespace, is_released: IsReleased) -> int:
    version = parse_config_version(pathlib.Path(args.config).read_text(encoding="utf-8"))
    if not version:
        print(f"Could not parse version from {args.config}", file=sys.stderr)
        return 1
    sections = parse_changelog_sections(pathlib.Path(args.changelog).read_text(encoding="utf-8"))
    pending = unreleased_prefix(sections, is_released)
    if not pending or pending[0][0] != version:
        print(
            f"{args.config} carries {version}, which is not the top of the "
            f"unreleased run in {args.changelog} — nothing pending, or the "
            f"changelog was not updated for this bump",
            file=sys.stderr,
        )
        return 1
    notes = render_notes(pending)
    pathlib.Path(args.write).write_text(notes or f"Release {version}\n", encoding="utf-8")
    return 0


def main(argv: list[str], is_released: IsReleased | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_version = sub.add_parser("version")
    p_version.add_argument("config")
    p_version.set_defaults(func=cmd_version)

    p_notes = sub.add_parser("notes")
    p_notes.add_argument("config")
    p_notes.add_argument("changelog")
    p_notes.add_argument("--write", required=True)
    p_notes.set_defaults(func=lambda a: cmd_notes(a, is_released or gh_release_exists))

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
