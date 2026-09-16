#!/usr/bin/env python3
"""Self-test for hygiene_scan — every rule catches its case, and only its case.

Three things are proved here, because a scanner can fail in three ways and only
one of them is visible from its output:

  1. each rule catches the shape it is for (VECTORS);
  2. each rule is the one doing the catching — disabling it makes its own vector
     pass, so a rule cannot be quietly redundant or dead (the mutation half);
  3. the two scanners in this repository do not overlap — no line is reported by
     both hygiene_scan and secret_scan, in either direction.

Plus the properties that are about the tree rather than the text: a clean tree
passes, a symlink that leaves the repository fails, and a file that cannot be
decoded is a FAILURE rather than a skip.

Run: python test_hygiene_scan.py   (exit 0 = pass, 1 = fail)
No test framework, no network, no fixtures on disk — the tree is built in a
temporary directory and removed again.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

import secret_scan
import test_secret_scan
from hygiene_scan import RULES, Rule, scan, scan_text

# rule name -> lines that rule must catch.
VECTORS: dict[str, list[str]] = {
    "machine-path": [
        "cwd = /Users/someone/project",
        'workdir: "/home/builder/app"',
        "socket at /private/tmp/session-4/ipc",
        "cache /var/folders/9k/abcd1234/T/build",
        r"path = C:\Users\someone\src",
        "see file:///Users/someone/project/notes.md",
        "launch: file:///home/builder/app/index.html",
    ],
    "transcript-url": [
        "see https://claude.ai/code/session_01ABCDEFxyz for the discussion",
        "notes: claude.ai/code/session/0123456789",
    ],
    "attribution-trailer": [
        "Co-Authored-By: Someone <someone@example.com>",
        "  co-authored-by: Someone Else <else@example.com>",
        "Generated with [Some Tool](https://example.com)",
        "\U0001F916 Generated with a tool",
    ],
}

# Lines that must NOT be reported: ordinary content that resembles a rule.
CLEAN = [
    "the add-on stores state under /data and reads /config",
    "docs live under /Users and are not paths",          # no path into it
    "run: docker build --tag addon-image:amd64 claude-code",
    "See https://www.home-assistant.io/integrations/ for the list",
    "co-authored the specification with the working group",  # not a trailer line
    "The image is generated with buildx",                    # not at line start
    "/home/ is not a path either",
    "mkdir -p /data/home/.claude/skills",   # a home inside a data dir
    "cache lives in /srv/Users/shared/x",   # not a per-machine path
    'mkdir -p "${work}/home/.claude/projects"',  # built from a variable
    'cd "$(mktemp -d)/Users/test/app"',          # likewise
]


def run_git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), *args], check=True,
                   capture_output=True, text=True)


def make_tree(root: Path, files: dict[str, bytes]) -> None:
    """A git repository containing exactly these files, all tracked."""
    run_git(root, "init", "-q")
    for rel, data in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    run_git(root, "add", "-A")


def check_rules_catch(failures: list[str]) -> None:
    for rule in RULES:
        if rule.name not in VECTORS:
            failures.append(f"rule {rule.name!r} has no test vector")
    for name, lines in VECTORS.items():
        for line in lines:
            hits = [n for n, _ in scan_text(line)]
            if name not in hits:
                failures.append(f"MISSED ({name}): {line!r} -> {hits}")


def check_clean_lines(failures: list[str]) -> None:
    for line in CLEAN:
        hits = scan_text(line)
        if hits:
            failures.append(f"FALSE POSITIVE: {line!r} -> {hits}")


def check_mutation(failures: list[str]) -> None:
    """Disable one rule at a time: its own vectors must then go unreported.

    This is what keeps a rule from being decorative. A vector that is still
    caught with its rule removed was being caught by something else, and the
    rule could be deleted without any test noticing."""
    for rule in RULES:
        weakened: list[Rule] = [r for r in RULES if r.name != rule.name]
        for line in VECTORS[rule.name]:
            hits = [n for n, _ in scan_text(line, weakened)]
            if rule.name in hits:
                failures.append(f"mutation: {rule.name!r} still reported itself")
            if hits:
                failures.append(
                    f"mutation: {line!r} is caught by {hits} as well as "
                    f"{rule.name!r} — the two rules overlap"
                )


def check_no_overlap_with_secret_scan(failures: list[str]) -> None:
    """Neither scanner may report a line the other one owns."""
    for lines in VECTORS.values():
        for line in lines:
            hits = secret_scan.scan_text(line)
            if hits:
                failures.append(
                    f"both scanners report {line!r}: secret-scan says {hits}"
                )
    for line in test_secret_scan.SHOULD_FLAG:
        hits = scan_text(line)
        if hits:
            failures.append(
                f"both scanners report {line!r}: hygiene says {hits}"
            )


def check_clean_tree(failures: list[str]) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        make_tree(root, {
            "README.md": b"# Fine\n\nPaths here are relative: ./src/app.js\n",
            "src/app.js": b"const base = './data';\n",
            "logo.png": b"\x89PNG\r\n\x1a\n\x00\x00binary",
        })
        os.symlink("src/app.js", root / "docs_link")
        run_git(root, "add", "-A")
        findings = scan(root)
        if findings:
            failures.append(f"clean tree reported: {[str(f) for f in findings]}")


def check_symlinks(failures: list[str]) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        make_tree(root, {"keep.txt": b"content\n", "sub/keep.txt": b"content\n"})
        os.symlink("/etc/hosts", root / "absolute_link")
        os.symlink("../../elsewhere", root / "sub" / "escaping_link")
        os.symlink("keep.txt", root / "sub" / "inside_link")
        run_git(root, "add", "-A")
        reported = {f.path: f.rule for f in scan(root)}
        for path, rule in (("absolute_link", "symlink-absolute"),
                           ("sub/escaping_link", "symlink-outside-repo")):
            if reported.get(path) != rule:
                failures.append(f"{path} -> {reported.get(path)}, expected {rule}")
        if "sub/inside_link" in reported:
            failures.append("a symlink inside the repository was reported")
        # The mutation half for a check that is not a regex: with the symlink
        # rule off, those same files must go unreported.
        still = [f for f in scan(root, symlinks=False) if "link" in f.path]
        if still:
            failures.append(f"mutation: symlinks still reported: {still}")


def check_unreadable_is_a_failure(failures: list[str]) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        # Text in a single-byte encoding: no NUL, so it is not taken for a
        # binary, and it is not valid UTF-8 either.
        make_tree(root, {"notes.txt": "héllo wörld".encode("latin-1")})
        findings = scan(root)
        if not any(f.rule == "unreadable" for f in findings):
            failures.append(f"an undecodable file passed: {[str(f) for f in findings]}")

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        make_tree(root, {"gone.txt": b"content\n"})
        (root / "gone.txt").unlink()          # tracked, but not there to read
        findings = scan(root)
        if not any(f.rule == "unreadable" for f in findings):
            failures.append("a missing tracked file passed as clean")


def check_self_skip_is_exact(failures: list[str]) -> None:
    """The scanner skips itself by path, not by name."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        make_tree(root, {"tools/hygiene_scan.py": b"p = '/Users/someone/x'\n"})
        if not scan(root):
            failures.append("a file merely NAMED hygiene_scan.py was skipped")


def run() -> int:
    failures: list[str] = []
    for check in (
        check_rules_catch,
        check_clean_lines,
        check_mutation,
        check_no_overlap_with_secret_scan,
        check_clean_tree,
        check_symlinks,
        check_unreadable_is_a_failure,
        check_self_skip_is_exact,
    ):
        check(failures)
    if failures:
        print("test_hygiene_scan: FAIL")
        for failure in failures:
            print("  " + failure)
        return 1
    vectors = sum(len(v) for v in VECTORS.values())
    print(f"test_hygiene_scan: pass ({len(RULES)} rules, {vectors} vectors, "
          f"{len(CLEAN)} clean lines, mutation and overlap checked)")
    return 0


if __name__ == "__main__":
    sys.exit(run())
