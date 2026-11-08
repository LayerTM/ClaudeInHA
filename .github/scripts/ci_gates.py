#!/usr/bin/env python3
"""The release job waits for every gate in the CI workflow, and no step runs an
image with a network.

`needs` is a hand-written list, and a hand-written list of gates goes stale the
first time a gate is added without touching it — quietly, in the direction that
ships: the new job is red, the release job never needed it, and a release is cut
for a commit that failed a check. Nothing in GitHub Actions expresses "depend on
everything", so the list stays and this asserts it is complete.

A job that must NOT gate a release (one that only runs on pull requests, say)
fails here on purpose: a release job that needs a skipped job is itself skipped,
so such a job would stop releases altogether. That is a decision to make in the
open, not by leaving it off a list.

Usage:
  ci_gates.py [workflow.yml]   -> silent and 0 when the list is complete

It also holds one rule about downloads: curl's --retry covers only a timeout and
HTTP 408/429/500/502/503/504, so a connection that dies mid-transfer (exit 56)
is never retried by it. A curl that asks for --retry therefore also asks for
--retry-all-errors, in every Dockerfile, shell script and workflow.
"""

from __future__ import annotations

import pathlib
import re
import subprocess
import sys

import yaml

DEFAULT = pathlib.Path(__file__).resolve().parents[2] / ".github/workflows/ci.yml"
RELEASE = "release"
# One `docker run` command, with the lines it continues onto.
DOCKER_RUN = re.compile(r"^[ \t]*docker run\b(?:.*\\\n)*.*", re.MULTILINE)


# One curl invocation, ending at the next shell separator or the end of the
# (continuation-joined) line.
CURL = re.compile(r"\bcurl\b(?:(?!&&|\|\||[;|\n]).)*")
RETRY = re.compile(r"(?<![\w-])--retry(?![\w-])")
RETRY_ALL = re.compile(r"(?<![\w-])--retry-all-errors(?![\w-])")
SCANNED = re.compile(r"(^|/)Dockerfile[^/]*$|\.(sh|ya?ml)$")


def curl_retry_complaints(name: str, text: str) -> list[str]:
    """Each curl in `text` that sets --retry without --retry-all-errors."""
    joined = re.sub(r"\\\n", " ", text)
    return [
        f"{name}: curl has --retry but not --retry-all-errors: {m.group(0).strip()[:90]}"
        for m in CURL.finditer(joined)
        if RETRY.search(m.group(0)) and not RETRY_ALL.search(m.group(0))
    ]


def check_curl_retries(root: pathlib.Path) -> list[str]:
    """Scan every tracked Dockerfile, shell script and workflow under `root`."""
    listed = subprocess.run(
        ["git", "-C", str(root), "ls-files"], capture_output=True, text=True
    )
    if listed.returncode != 0:
        return [f"cannot list the files of {root}: {listed.stderr.strip()}"]
    complaints = []
    for rel in listed.stdout.splitlines():
        if SCANNED.search(rel) and (root / rel).is_file():
            text = (root / rel).read_text(encoding="utf-8", errors="replace")
            complaints += curl_retry_complaints(rel, text)
    return complaints


def check(path: pathlib.Path) -> list[str]:
    """Complaints about this workflow's gate list; empty means it is whole."""
    try:
        with path.open(encoding="utf-8") as handle:
            workflow = yaml.safe_load(handle)
    except FileNotFoundError:
        return [f"{path} is missing"]
    if not isinstance(workflow, dict) or not isinstance(workflow.get("jobs"), dict):
        return [f"{path} has no jobs mapping"]

    jobs = workflow["jobs"]
    if RELEASE not in jobs:
        return [f"{path} has no '{RELEASE}' job — this check is aimed at nothing"]

    needs = jobs[RELEASE].get("needs") or []
    if isinstance(needs, str):
        needs = [needs]
    waits_for = set(needs)
    gates = set(jobs) - {RELEASE}

    complaints = []
    # The service script talks to `homeassistant` on purpose, and that name can
    # resolve to a real home where this runs; a token check from a test would be a
    # failed login there.
    for command in DOCKER_RUN.findall(path.read_text(encoding="utf-8")):
        if "--network none" not in command:
            complaints.append(f"a step runs an image with a network: {command.strip().splitlines()[0]}")
    for job in sorted(gates - waits_for):
        complaints.append(
            f"job '{job}' is a gate the '{RELEASE}' job does not wait for — "
            f"add it to its needs, or say why a release may be cut past it"
        )
    for job in sorted(waits_for - gates):
        complaints.append(f"'{RELEASE}' needs '{job}', which is not a job in {path.name}")
    return complaints


def main() -> None:
    path = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    complaints = check(path) + check_curl_retries(DEFAULT.parents[2])
    if complaints:
        for line in complaints:
            print(line, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
