#!/usr/bin/env python3
"""What a release's version and notes are, for the commit CI just measured.

Releases are no longer cut on every push, so several version bumps can land
on main between two release cuts. CHANGELOG.md lists every version's own
section once, newest first — if a cut only ever took the top section, a
version bumped and superseded before its own cut would vanish from every
release's notes for good. This walks down from the top of the changelog and
collects sections until it reaches the one already released, so a release cut
after N pending bumps still carries all N of them.

Commands:
  version <config.yaml>
                    print the version config.yaml declares; exit 1 if it
                    cannot be parsed.
  notes <config.yaml> <CHANGELOG.md> --since VERSION --write PATH
                    write the combined notes for every changelog section
                    above VERSION (empty means no release exists yet) to
                    PATH. VERSION not found in the changelog is treated the
                    same as "no prior release found" and only the top section
                    is written, so a changelog rewrite cannot make one cut
                    silently swallow the file's whole history.

Run: python3 .github/scripts/release_notes.py <command> ...
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys

VERSION_RE = re.compile(r'^version:\s*"?(\d+\.\d+\.\d+)', re.MULTILINE)
HEADER_RE = re.compile(r"^## \[(\d+\.\d+\.\d+)\][^\n]*$", re.MULTILINE)


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


def sections_since(sections: list[tuple[str, str]], since: str | None) -> list[tuple[str, str]]:
    """The leading sections newer than `since` (all of them if it is absent).

    `since` missing from `sections` — a changelog that no longer carries the
    version its last release was cut for — falls back to just the top section
    rather than the whole file, which is what a truncated or reorganised
    changelog would otherwise dump into one release's notes.
    """
    if since and since not in (version for version, _ in sections):
        return sections[:1]
    result = []
    for version, body in sections:
        if version == since:
            break
        result.append((version, body))
    return result


def render_notes(sections: list[tuple[str, str]]) -> str:
    if not sections:
        return ""
    return "\n\n".join(body for _, body in sections) + "\n"


def cmd_version(args: argparse.Namespace) -> int:
    version = parse_config_version(pathlib.Path(args.config).read_text(encoding="utf-8"))
    if not version:
        print(f"Could not parse version from {args.config}", file=sys.stderr)
        return 1
    print(version)
    return 0


def cmd_notes(args: argparse.Namespace) -> int:
    version = parse_config_version(pathlib.Path(args.config).read_text(encoding="utf-8"))
    if not version:
        print(f"Could not parse version from {args.config}", file=sys.stderr)
        return 1
    sections = parse_changelog_sections(pathlib.Path(args.changelog).read_text(encoding="utf-8"))
    pending = sections_since(sections, args.since or None)
    if not pending or pending[0][0] != version:
        print(
            f"{args.config} carries {version}, which is not the top of "
            f"{args.changelog} above {args.since or '(no prior release)'}",
            file=sys.stderr,
        )
        return 1
    notes = render_notes(pending)
    pathlib.Path(args.write).write_text(notes or f"Release {version}\n", encoding="utf-8")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_version = sub.add_parser("version")
    p_version.add_argument("config")
    p_version.set_defaults(func=cmd_version)

    p_notes = sub.add_parser("notes")
    p_notes.add_argument("config")
    p_notes.add_argument("changelog")
    p_notes.add_argument("--since", default="")
    p_notes.add_argument("--write", required=True)
    p_notes.set_defaults(func=cmd_notes)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
