#!/usr/bin/env python3
"""What a pin behind its upstream means, and where it goes: a bump pull request.

A pull request is the change that has to be right, so on a pull request (and on
any branch other than main) a pin behind its upstream fails the "Upstream pins"
check, exactly as `pins.py check` reports it. On main the same answer is news,
not a defect of the commit: the upstream published a release after the commit
passed. Turning main red for it only says "something upstream moved" in the
colour that means "this commit is broken". So on main the drift is recorded,
the run stays green, the release is held back (ci.yml's release job reads the
`drift` output), and one pull request carries the bump.

An upstream that could not be read is never drift: `pins.py check` exits 2 for
it and that stays a failure everywhere, because a reading that did not happen
is not a reading that said "behind".

Commands:
  verdict STATUS CHECK_OUTPUT
      STATUS is the exit status of `pins.py check` and CHECK_OUTPUT the file
      holding what it printed. Writes `drift=true|false` to $GITHUB_OUTPUT and
      exits with the status the check must have here: 0 current; behind (exit
      1 with the check's own "behind" lines) red on any ref but main, green
      with drift=true on main; anything else, a crash included, red.

  open-pr
      On main, with drift recorded: runs `pins.py bump`, commits the result on
      top of main to the branch `pins/bump`, opens the pull request for it (or
      updates the one already open), and starts ci.yml on that branch. A pull
      request made with the workflow token raises no pull_request event, and a
      workflow_dispatch is the one event that token may start; the run it
      starts reports every check the pull request is required to pass, on the
      very commit the pull request points at.

      The branch belongs to this workflow. A commit on it that the workflow did
      not make (a maintainer adding the changelog line, say) means a person is
      finishing it, and the branch is then left exactly as it is; so is a
      branch already built on a newer main. A pull request with exactly this
      bump that was closed without merging is not opened again.

Both commands write what they decided to $GITHUB_STEP_SUMMARY when it is set.
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import sys

MAIN_REF = "refs/heads/main"
BRANCH = "pins/bump"
BOT_NAME = "github-actions[bot]"
BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com"
TITLE = "Move upstream pins to their latest releases"
SCRIPTS = pathlib.Path(__file__).resolve().parent


def out(name: str, value: str) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(f"{name}={value}\n")


def summary(text: str) -> None:
    print(text)
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(text + "\n")


BEHIND_LINE = re.compile(r"^behind\s")
BEHIND_TOTAL = re.compile(r"^\d+ pin\(s\) behind upstream")


def is_drift(report: str) -> bool:
    """`pins.py check` said "behind", in its own words. Exit 1 alone is not
    enough: a crash exits 1 too, and a crash is not a reading."""
    lines = report.splitlines()
    return any(BEHIND_LINE.match(line) for line in lines) and any(BEHIND_TOTAL.match(line) for line in lines)


def verdict(status: int, report: str, ref: str) -> int:
    drift = status == 1 and is_drift(report)
    if status == 0:
        out("drift", "false")
        return 0
    if drift and ref == MAIN_REF:
        out("drift", "true")
        summary(
            "**Upstream pins:** at least one pin is behind its upstream (listed in this job's log). "
            "This commit is not failed for it: the release waits, and the bump arrives as the "
            f"pull request from `{BRANCH}`."
        )
        return 0
    out("drift", "false")
    if drift:
        summary("**Upstream pins:** a pin is behind its upstream. Run `python3 .github/scripts/pins.py bump`.")
        return 1
    summary(f"**Upstream pins:** the check did not produce a reading (exit {status}); "
            "an upstream that could not be read is not a pin behind it.")
    return status or 1


class Failed(Exception):
    pass


def run(*cmd: str, cwd: pathlib.Path, check: bool = True) -> subprocess.CompletedProcess:
    done = subprocess.run(list(cmd), cwd=cwd, capture_output=True, text=True, check=False)
    if check and done.returncode != 0:
        raise Failed(f"{' '.join(cmd)} exited {done.returncode}: {(done.stderr or done.stdout).strip()}")
    return done


def git(root: pathlib.Path, *args: str, check: bool = True) -> str:
    return run("git", *args, cwd=root, check=check).stdout.strip()


def describe(changes: list[dict]) -> list[str]:
    lines = []
    for change in changes:
        if change["kind"].endswith("-sha256"):
            continue
        major = " (new major version)" if change.get("major") else ""
        lines.append(f"- {change['name']}: {change['from']} → {change['to']}{major} — `{change['file']}`, "
                     f"{change['kind']} {change['source']}")
    return lines


def body(changes: list[dict]) -> str:
    return "\n".join([
        "Every pin below has a newer upstream release than the one this repository builds on.",
        "",
        *describe(changes),
        "",
        "Checksums that belong to a version move with it. The change is exactly what "
        "`python3 .github/scripts/pins.py bump` writes on top of main.",
        "",
        "Before merging: add the changelog entry these updates need under `## Unreleased`; "
        "the version itself moves only in the release pull request.",
    ]) + "\n"


def pin_set(text: str) -> set[str]:
    return {line for line in text.splitlines() if line.startswith("- ")}


BOT_LOGIN = "github-actions[bot]"


def repository() -> str:
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if "/" not in repo:
        raise Failed("GITHUB_REPOSITORY is not set; cannot tell which repository the bump belongs to")
    return repo


def pulls(root: pathlib.Path) -> list[dict]:
    """Every pull request this workflow opened from the bump branch, newest first.

    A branch called pins/bump can exist in any fork. The question is asked as
    `head=<this owner>:pins/bump`, so GitHub answers only for this repository's
    own branch, every page of it; each answer is then checked again for its head
    repository and for the workflow as its author, and any other is neither
    edited nor taken as a verdict on the bump."""
    repo = repository()
    owner = repo.split("/", 1)[0]
    listed = run("gh", "api", "--paginate",
                 f"repos/{repo}/pulls?head={owner}:{BRANCH}&base=main&state=all&per_page=100",
                 "--jq", ".[] | {number, state, merged_at, body, sha: .head.sha,"
                 " head_repo: .head.repo.full_name, user: .user.login}", cwd=root).stdout
    found = []
    for line in listed.splitlines():
        if not line.strip():
            continue
        p = json.loads(line)
        if p.get("head_repo") != repo or p.get("user") != BOT_LOGIN:
            continue
        state = "MERGED" if p.get("merged_at") else ("OPEN" if p.get("state") == "open" else "CLOSED")
        found.append({"number": p["number"], "state": state, "headRefOid": p.get("sha"), "body": p.get("body") or ""})
    return found


def ci_runs(root: pathlib.Path, sha: str) -> int:
    count = run("gh", "api", f"repos/{repository()}/actions/workflows/ci.yml/runs?head_sha={sha}",
                "--jq", ".total_count", cwd=root).stdout.strip()
    return int(count or "0")


def open_pr(root: pathlib.Path, bump: list[str] | None = None) -> int:
    bump = bump or [sys.executable, str(SCRIPTS / "pins.py"), "bump"]
    # Which commits the branch has that main does not is a question about
    # history; a shallow clone answers it with every commit it cannot see.
    if git(root, "rev-parse", "--is-shallow-repository") == "true":
        git(root, "fetch", "--quiet", "--unshallow", "origin")
    main_sha = git(root, "rev-parse", "HEAD")
    record = pathlib.Path(os.environ.get("RUNNER_TEMP") or root) / "pins-bump.json"
    bumped = run(*bump, "--summary", str(record), cwd=root, check=False)
    print(bumped.stdout, end="")
    if bumped.returncode != 0:
        print(bumped.stderr, end="", file=sys.stderr)
        return bumped.returncode or 1
    changes = json.loads(record.read_text())
    record.unlink()
    if not changes or not git(root, "status", "--porcelain"):
        summary("**Upstream pins:** every pin matches its upstream now; no bump pull request is needed.")
        return 0
    text = body(changes)
    history = pulls(root)
    opened = next((p for p in history if p["state"] == "OPEN"), None)
    if not opened:
        declined = next((p for p in history if p["state"] == "CLOSED" and pin_set(p["body"]) == pin_set(text)), None)
        if declined:
            summary(f"::warning::**Upstream pins:** pull request #{declined['number']} with exactly this bump was "
                    "closed without merging; it is not opened again. The release waits until the pins move.")
            return 0

    git(root, "switch", "--quiet", "-C", BRANCH)
    git(root, "add", "--all")
    message = "\n".join([TITLE, "", *describe(changes)]) + "\n"
    git(root, "-c", f"user.name={BOT_NAME}", "-c", f"user.email={BOT_EMAIL}",
        "commit", "--quiet", "-m", message)
    new = git(root, "rev-parse", "HEAD")

    pushed = False
    for _ in range(3):
        remote = git(root, "ls-remote", "origin", f"refs/heads/{BRANCH}")
        old = remote.split()[0] if remote else ""
        if old:
            git(root, "fetch", "--quiet", "origin", f"+refs/heads/{BRANCH}:refs/remotes/origin/{BRANCH}")
            # A branch is someone's work only while it is the head of an open
            # pull request or of none; one whose pull request merged or closed
            # is spent, and is rebuilt.
            spent = any(p["headRefOid"] == old and p["state"] != "OPEN" for p in history)
            if not spent:
                # A run of an older main arriving late must not rewind the branch.
                base = git(root, "rev-parse", f"{old}^")
                if base != main_sha and run("git", "merge-base", "--is-ancestor", main_sha, base,
                                            cwd=root, check=False).returncode == 0:
                    summary(f"**Upstream pins:** `{BRANCH}` is already built on a newer main; left as it is.")
                    return 0
                others = git(root, "log", "--format=%ae%n%ce", old, "--not", main_sha).split()
                if any(email != BOT_EMAIL for email in others):
                    summary(f"**Upstream pins:** `{BRANCH}` carries a commit this workflow did not make; "
                            "it is left as it is for whoever is finishing it.")
                    return 0
        if old and git(root, "rev-parse", f"{old}^") == main_sha and \
                git(root, "rev-parse", f"{old}^{{tree}}") == git(root, "rev-parse", f"{new}^{{tree}}"):
            head = old
            print(f"{BRANCH} already carries this bump on top of main")
            break
        lease = f"--force-with-lease=refs/heads/{BRANCH}:{old}"
        if run("git", "push", "--quiet", lease, "origin", f"HEAD:refs/heads/{BRANCH}",
               cwd=root, check=False).returncode == 0:
            head, pushed = new, True
            print(f"pushed {BRANCH} at {new}")
            break
        print(f"{BRANCH} moved while it was being written; reading it again")
    else:
        raise Failed(f"{BRANCH} kept moving; three attempts to write it lost the race")

    if opened:
        number, created = str(opened["number"]), False
        run("gh", "pr", "edit", number, "--title", TITLE, "--body", text, cwd=root)
    else:
        made = run("gh", "pr", "create", "--base", "main", "--head", BRANCH,
                   "--title", TITLE, "--body", text, cwd=root)
        number, created = made.stdout.strip().rsplit("/", 1)[-1], True
    # A push or a pull request made with the workflow token starts no workflow;
    # this dispatch is what puts the required checks on the head commit. It is
    # owed whenever that commit has no CI run yet, not only right after a push.
    dispatched = pushed or created or ci_runs(root, head) == 0
    if dispatched:
        run("gh", "workflow", "run", "ci.yml", "--ref", BRANCH, cwd=root)
    summary(f"**Upstream pins:** the bump is pull request #{number} (`{BRANCH}` at {head[:12]})"
            + ("; CI was started on it." if dispatched else "."))
    return 0


def main(argv: list[str]) -> int:
    root = SCRIPTS.parents[1]
    try:
        if len(argv) == 3 and argv[0] == "verdict" and argv[1].isdigit():
            report = pathlib.Path(argv[2]).read_text(encoding="utf-8", errors="replace")
            return verdict(int(argv[1]), report, os.environ.get("GITHUB_REF", ""))
        if argv == ["open-pr"]:
            return open_pr(root)
    except (Failed, OSError, ValueError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    print("usage: pins_drift.py verdict STATUS CHECK_OUTPUT | open-pr", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
