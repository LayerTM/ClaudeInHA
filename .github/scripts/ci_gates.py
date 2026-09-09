#!/usr/bin/env python3
"""The release job waits for every gate in the CI workflow.

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
"""

from __future__ import annotations

import pathlib
import sys

import yaml

DEFAULT = pathlib.Path(__file__).resolve().parents[2] / ".github/workflows/ci.yml"
RELEASE = "release"


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
    complaints = check(path)
    if complaints:
        for line in complaints:
            print(line, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
