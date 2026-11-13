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

The heading form this reads is the one this changelog is written in, `## [1.63.3]`,
and the unbracketed `## 1.63.3` other repositories use. The changelog is the text
users read in the update dialog before they update; a heading is not rewritten
to suit the reader of it.

Commands:
  version <config.yaml>
                    print the version config.yaml declares; exit 1 if it
                    cannot be parsed.
  notes <config.yaml> <CHANGELOG.md> --write PATH
                    write the combined notes for every unreleased changelog
                    section to PATH; exit 1 if config.yaml's version is not
                    the top of that unreleased run (nothing pending, or the
                    changelog was not updated for the bump), 2 if GitHub
                    could not be asked.
  released <version>
                    exit 0 if v<version> has a release, 1 if GitHub says it has
                    none, 2 if the lookup itself failed (the reason is printed
                    to stderr) — a broken lookup is never read as "none".
  pending-since <config.yaml>
                    print the commit time (epoch seconds) of the commit that
                    put config.yaml's current version there; exit 1 if git
                    history does not show one.
  version-move <base config.yaml> <head config.yaml> <pull request title>
               --changelog <head CHANGELOG.md> [--base-changelog <base CHANGELOG.md>]
                    exit 0 if the version is the same on both sides, or the
                    pull request is the release of the head version (its
                    title starts "Release X.Y.Z"); exit 1 otherwise. The
                    add-on store offers config.yaml's version from main the
                    moment a pull request merges, so a version that moves
                    anywhere but in its own release pull request reaches users
                    before it is released. A base without a parseable version
                    counts as a move. The changelog is checked with it: a pull
                    request that does not release writes its lines under
                    `## Unreleased`, the first section; the release pull
                    request renames that heading to its version, so it carries
                    no Unreleased section and its version is the top one.
                    A section whose version is already released (asked of
                    GitHub, as `released` does) is changed only by a release
                    pull request; exit 2 when GitHub cannot say.

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
HEADER_RE = re.compile(r"^## \[?(\d+\.\d+\.\d+)\]?[^\n]*$", re.MULTILINE)
# Every second-level heading, and the one for changes not yet released.
SECTION_RE = re.compile(r"^## [^\n]*$", re.MULTILINE)
UNRELEASED_RE = re.compile(r"^## \[?Unreleased\]?\s*$")

# "Release 0.3.8" alone, or followed by ":" and a summary, as release pull
# requests are titled; "Release 0.3.80" is not a release of 0.3.8.
RELEASE_TITLE_RE = re.compile(r"^Release (\d+\.\d+\.\d+)(?![\d.])")

IsReleased = Callable[[str], bool]


class ReleaseLookupError(RuntimeError):
    """`gh` could not say whether a release exists (no network, bad token, rate limit)."""


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
    """Whether v<version> has a release; raises ReleaseLookupError if gh cannot tell.

    `gh release view` exits 1 for "no such release" AND for a bad token or no
    network (measured: a 401 and a refused connection both exit 1), so the
    exit code alone cannot separate an answer from a broken instrument. What
    does is gh's own "release not found"; anything else is an error, never
    "no release yet" — that reading would hand a release the notes of the
    whole changelog. Limit: "release not found" does not tell a missing
    release from an unreachable or misnamed repository (gh prints it for
    both); in the workflows the repository comes from the checkout, which
    is what holds that limit.
    """
    result = subprocess.run(
        ["gh", "release", "view", f"v{version}"],
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        return True
    if result.returncode == 1 and "release not found" in result.stderr:
        return False
    raise ReleaseLookupError(
        f"gh release view v{version} exited {result.returncode}: "
        f"{result.stderr.strip() or '(no stderr)'}"
    )


def pending_since(config: pathlib.Path) -> int | None:
    """Commit time of the commit that put config.yaml's current version there,
    or None when git history does not show one."""
    version = parse_config_version(config.read_text(encoding="utf-8"))
    if not version:
        return None
    result = subprocess.run(
        [
            "git", "log", "-1", "--format=%ct",
            f'-G^version:[ ]*"?{re.escape(version)}"?[ ]*$',
            "--", config.name,
        ],
        capture_output=True,
        text=True,
        cwd=config.resolve().parent,
    )
    out = result.stdout.strip()
    return int(out) if result.returncode == 0 and out.isdigit() else None


def cmd_version(args: argparse.Namespace) -> int:
    version = parse_config_version(pathlib.Path(args.config).read_text(encoding="utf-8"))
    if not version:
        print(f"Could not parse version from {args.config}", file=sys.stderr)
        return 1
    print(version)
    return 0


def cmd_released(args: argparse.Namespace, is_released: IsReleased) -> int:
    try:
        return 0 if is_released(args.version) else 1
    except ReleaseLookupError as error:
        print(error, file=sys.stderr)
        return 2


def cmd_pending_since(args: argparse.Namespace) -> int:
    since = pending_since(pathlib.Path(args.config))
    if since is None:
        print(f"{args.config}: git history does not show when it took its current version", file=sys.stderr)
        return 1
    print(since)
    return 0


def has_unreleased(text: str) -> bool:
    return any(UNRELEASED_RE.match(m.group(0)) for m in SECTION_RE.finditer(text))


def cmd_notes(args: argparse.Namespace, is_released: IsReleased) -> int:
    version = parse_config_version(pathlib.Path(args.config).read_text(encoding="utf-8"))
    if not version:
        print(f"Could not parse version from {args.config}", file=sys.stderr)
        return 1
    changelog_text = pathlib.Path(args.changelog).read_text(encoding="utf-8")
    # A change merged after the release pull request is in the tree being
    # released, but its line is still under Unreleased, which no release's
    # notes read. Cutting now would ship it unlisted; a release pull request
    # has to name it first.
    if has_unreleased(changelog_text):
        print(
            f"{args.changelog} still has an Unreleased section: the tree carries changes no release lists. "
            f"Rename it to the next version in a release pull request before cutting {version}.",
            file=sys.stderr,
        )
        return 1
    sections = parse_changelog_sections(changelog_text)
    try:
        pending = unreleased_prefix(sections, is_released)
    except ReleaseLookupError as error:
        print(f"Cannot tell which versions are released, so no notes: {error}", file=sys.stderr)
        return 2
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


def version_move(base: str | None, head: str | None, title: str) -> str | None:
    """Why this pull request may not carry this version change, or None if it may."""
    if head is None:
        return "the pull request's config.yaml declares no version"
    if base == head:
        return None
    match = RELEASE_TITLE_RE.match(title.strip())
    if match and match.group(1) == head:
        return None
    return (
        f"config.yaml's version moves from {base or 'none'} to {head}, but this pull request is not "
        f"titled 'Release {head}'. The add-on store offers main's version as soon as this merges, "
        f"so the version moves only in the release pull request."
    )


def changelog_problem(text: str, moved: bool, head: str | None) -> str | None:
    """What is wrong with the changelog a pull request carries, or None.

    Lines for changes not yet released go under `## Unreleased`, which must be
    the first section (the notes of a release are the versioned sections above
    the last release, so text above the first version is never in them). The
    release pull request renames it to its version: it carries no Unreleased
    section, and its version is the top one.
    """
    headings = [m.group(0) for m in SECTION_RE.finditer(text)]
    unreleased = [i for i, h in enumerate(headings) if UNRELEASED_RE.match(h)]
    if len(unreleased) > 1:
        return "the changelog has more than one Unreleased section"
    if unreleased and unreleased[0] != 0:
        return "the changelog's Unreleased section is not its first section"
    if not moved:
        return None
    if unreleased:
        return f"a release pull request renames '## Unreleased' to '## {head}'; this one still carries it"
    sections = parse_changelog_sections(text)
    top = sections[0][0] if sections else None
    if top != head:
        return f"the changelog's top section is {top or 'none'}, but this pull request releases {head}"
    return None


def released_section_changed(base_text: str, head_text: str, is_released: IsReleased) -> str | None:
    """The first released version whose changelog section this pull request changes, as a reason, or None.

    The notes of a released version are what users were shown; a pull request
    rewriting them changes history under the release. Only sections that differ
    are looked up, so an untouched changelog asks GitHub nothing.
    """
    head = dict(parse_changelog_sections(head_text))
    for version, body in parse_changelog_sections(base_text):
        if head.get(version) == body:
            continue
        if is_released(version):
            what = "removes" if version not in head else "changes"
            return (
                f"this pull request {what} the changelog section of {version}, which is already released. "
                f"Correct it in a release pull request, or merge over this check deliberately if the "
                f"released notes really must change."
            )
    return None


def cmd_version_move(args: argparse.Namespace, is_released: IsReleased) -> int:
    base_path = pathlib.Path(args.base)
    base = parse_config_version(base_path.read_text(encoding="utf-8")) if base_path.is_file() else None
    head = parse_config_version(pathlib.Path(args.head).read_text(encoding="utf-8"))
    head_log = pathlib.Path(args.changelog).read_text(encoding="utf-8")
    base_log_path = pathlib.Path(args.base_changelog) if args.base_changelog else None
    base_log = base_log_path.read_text(encoding="utf-8") if base_log_path and base_log_path.is_file() else ""
    reason = version_move(base, head, args.title) or changelog_problem(head_log, base != head, head)
    # A release pull request may correct released notes; nothing else may.
    if not reason and base == head:
        try:
            reason = released_section_changed(base_log, head_log, is_released)
        except ReleaseLookupError as error:
            print(f"Cannot tell which changelog sections are released: {error}", file=sys.stderr)
            return 2
    if reason:
        print(reason, file=sys.stderr)
        return 1
    print(f"version {head}: " + ("unchanged" if base == head else "moved by its release pull request"))
    return 0


def main(argv: list[str], is_released: IsReleased | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_version = sub.add_parser("version")
    p_version.add_argument("config")
    p_version.set_defaults(func=cmd_version)

    p_released = sub.add_parser("released")
    p_released.add_argument("version")
    p_released.set_defaults(func=lambda a: cmd_released(a, is_released or gh_release_exists))

    p_since = sub.add_parser("pending-since")
    p_since.add_argument("config")
    p_since.set_defaults(func=cmd_pending_since)

    p_notes = sub.add_parser("notes")
    p_notes.add_argument("config")
    p_notes.add_argument("changelog")
    p_notes.add_argument("--write", required=True)
    p_notes.set_defaults(func=lambda a: cmd_notes(a, is_released or gh_release_exists))

    p_move = sub.add_parser("version-move")
    p_move.add_argument("base")
    p_move.add_argument("head")
    p_move.add_argument("title")
    p_move.add_argument("--changelog", required=True)
    p_move.add_argument("--base-changelog")
    p_move.set_defaults(func=lambda a: cmd_version_move(a, is_released or gh_release_exists))

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
