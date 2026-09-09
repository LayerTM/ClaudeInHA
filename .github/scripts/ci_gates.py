#!/usr/bin/env python3
"""Invariants of the CI workflow that nothing else would notice breaking.

Two, and both are about a gate quietly ceasing to be one.

`needs` is a hand-written list, and a hand-written list of gates goes stale the
first time a gate is added without touching it — quietly, in the direction that
ships: the new job is red, the release job never needed it, and a release is cut
for a commit that failed a check. Nothing in GitHub Actions expresses "depend on
everything", so the list stays and this asserts it is complete.

A job that must NOT gate a release (one that only runs on pull requests, say)
fails here on purpose: a release job that needs a skipped job is itself skipped,
so such a job would stop releases altogether. That is a decision to make in the
open, not by leaving it off a list.

Second: a step marked `continue-on-error` is a step whose failure does not
count, and the retries around a flaky registry are written that way. If the LAST
attempt were marked too, the check would still run, still go through the motions,
and never be able to fail — the most expensive kind of green. So every action
that is retried must also appear once WITHOUT `continue-on-error`.

Usage:
  ci_gates.py [workflow.yml]   -> silent and 0 when both hold
"""

from __future__ import annotations

import pathlib
import sys

import yaml

DEFAULT = pathlib.Path(__file__).resolve().parents[2] / ".github/workflows/ci.yml"
RELEASE = "release"



def _retries_still_decide(jobs):
    """Complaints about actions that are retried into never failing."""
    for name, job in sorted(jobs.items()):
        steps = job.get('steps') or []
        forgiven = set()
        decisive = set()
        for step in steps:
            uses = step.get('uses')
            if not uses:
                continue
            # A literal `true`, or the string GitHub also accepts.
            if str(step.get('continue-on-error', False)).lower() == 'true':
                forgiven.add(uses)
            else:
                decisive.add(uses)
        for uses in sorted(forgiven - decisive):
            yield (
                f"job '{name}' retries '{uses}' but every attempt is "
                f"continue-on-error, so it can never fail the run — the last "
                f"attempt must be the one that decides"
            )


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

    complaints = list(_retries_still_decide(jobs))
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
