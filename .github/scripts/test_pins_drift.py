#!/usr/bin/env python3
"""Self-test for pins_drift.py — offline: git runs against a local bare
repository and `gh` is a recording stand-in on PATH.

The two answers that matter: a pin behind its upstream fails a pull request and
leaves main green with the bump pull request opened; an upstream that could not
be read fails both.

Run: python3 .github/scripts/test_pins_drift.py
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import pins_drift  # noqa: E402

FAILURES: list[str] = []

# Stands in for pins.py bump: moves the one pin in pins.txt to the value in
# $FAKE_BUMP_TO and writes the summary pins.py would write; an empty value means
# "already current", and $FAKE_BUMP_EXIT makes it fail like an unreadable upstream.
FAKE_BUMP = """
import json, os, pathlib, sys
if os.environ.get("FAKE_BUMP_EXIT"):
    sys.exit(int(os.environ["FAKE_BUMP_EXIT"]))
to = os.environ.get("FAKE_BUMP_TO", "")
pin = pathlib.Path("pins.txt")
was = pin.read_text().strip()
changes = []
if to and to != was:
    pin.write_text(to + "\\n")
    changes = [{"name": "TOOL_VERSION", "file": "pins.txt", "kind": "npm", "source": "tool",
                "from": was, "to": to, "major": False},
               {"name": "TOOL_SHA256", "file": "pins.txt", "kind": "claude-code-sha256",
                "source": "linux-x64", "from": "a", "to": "b", "major": False}]
pathlib.Path(sys.argv[sys.argv.index("--summary") + 1]).write_text(json.dumps(changes))
"""

# Records every call. `pr list` answers $FAKE_GH_PRS (a JSON list of pull
# requests), `pr create` prints a URL or fails with $FAKE_GH_CREATE_FAILS, and
# `api` (the CI runs on a commit) answers $FAKE_GH_RUNS.
FAKE_GH = """#!/usr/bin/env python3
import json, os, sys
with open(os.environ["FAKE_GH_LOG"], "a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\\n")
args = sys.argv[1:]
if args[:2] == ["api", "--paginate"] and "/pulls?" in args[2]:
    # What `--jq` would print: one object per line, for the head asked about only.
    owner_head = args[2].split("head=", 1)[1].split("&", 1)[0]
    for p in json.loads(os.environ.get("FAKE_GH_PRS") or "[]"):
        if p.pop("_head") == owner_head:
            print(json.dumps(p))
elif args[:2] == ["pr", "create"]:
    if os.environ.get("FAKE_GH_CREATE_FAILS"):
        sys.exit(1)
    print("https://github.com/owner/repo/pull/77")
elif args[:1] == ["api"]:
    print(os.environ.get("FAKE_GH_RUNS") or "0")
"""

def check(name: str, ok: bool, detail: str = "") -> None:
    print(("ok   " if ok else "FAIL ") + name + (f": {detail}" if detail and not ok else ""))
    if not ok:
        FAILURES.append(name)


def sh(cwd: pathlib.Path, *cmd: str) -> str:
    return subprocess.run(list(cmd), cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()


@contextlib.contextmanager
def env(**values: str):
    saved = {k: os.environ.get(k) for k in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def outputs(path: pathlib.Path) -> dict[str, str]:
    return dict(line.split("=", 1) for line in path.read_text().split()) if path.exists() else {}


BEHIND = ("current  A (Dockerfile:3, npm a): 1.0.0\n"
          "behind   B (Dockerfile:5, npm b): 1.0.0 -> 1.1.0\n"
          "1 pin(s) behind upstream; run: python3 .github/scripts/pins.py bump\n")
CURRENT = "current  A (Dockerfile:3, npm a): 1.0.0\nall 1 pins match their upstream\n"
CRASH = "Traceback (most recent call last):\n  File \"pins.py\", line 1\nKeyError: 'x'\n"


def test_verdict() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        for n, (ref, status, report, want_exit, want_drift) in enumerate([
            ("refs/heads/main", 0, CURRENT, 0, "false"),
            ("refs/heads/main", 1, BEHIND, 0, "true"),     # drift on main: green, recorded
            ("refs/heads/main", 2, "", 2, "false"),        # unreadable upstream: red on main too
            ("refs/heads/main", 1, CRASH, 1, "false"),     # a crash exits 1 too, and is not drift
            ("refs/pull/5/merge", 0, CURRENT, 0, "false"),
            ("refs/pull/5/merge", 1, BEHIND, 1, "false"),  # drift on a pull request: red
            ("refs/pull/5/merge", 2, "", 2, "false"),
            ("refs/heads/pins/bump", 1, BEHIND, 1, "false"),  # the bump branch itself is gated
        ]):
            out = pathlib.Path(tmp) / f"out-{n}"
            step = pathlib.Path(tmp) / "summary.md"
            name = f"verdict {ref} status {status} ({'crash' if report == CRASH else 'reading'})"
            with env(GITHUB_OUTPUT=str(out), GITHUB_STEP_SUMMARY=str(step)), \
                    contextlib.redirect_stdout(io.StringIO()):
                got = pins_drift.verdict(status, report, ref)
            check(f"{name} exits {want_exit}", got == want_exit, f"got {got}")
            check(f"{name} drift={want_drift}", outputs(out).get("drift") == want_drift, str(outputs(out)))


BOT = (pins_drift.BOT_NAME, pins_drift.BOT_EMAIL)
HUMAN = ("Maintainer", "maintainer@example.com")


class Repo:
    """A bare origin whose main holds pins.txt at 1.0.0, and a clone of it."""

    def __init__(self, tmp: pathlib.Path):
        self.tmp = tmp
        self.origin = tmp / "origin.git"
        self.root = tmp / "clone"
        self.log = tmp / "gh.log"
        self.bump = tmp / "fake_bump.py"
        self.bump.write_text(FAKE_BUMP)
        bindir = tmp / "bin"
        bindir.mkdir()
        (bindir / "gh").write_text(FAKE_GH)
        (bindir / "gh").chmod(0o755)
        self.path = f"{bindir}{os.pathsep}{os.environ['PATH']}"
        self.temp = tmp / "runner-temp"
        self.temp.mkdir()
        sh(tmp, "git", "init", "--quiet", "--bare", "--initial-branch=main", str(self.origin))
        self.clone(depth=0)
        (self.root / "pins.txt").write_text("1.0.0\n")
        self.commit("start", *HUMAN)
        sh(self.root, "git", "push", "--quiet", "origin", "HEAD:refs/heads/main")

    def clone(self, depth: int) -> None:
        """A fresh clone, as actions/checkout makes one; depth 1 is its default."""
        if self.root.exists():
            sh(self.tmp, "rm", "-rf", str(self.root))
        extra = ["--depth", str(depth)] if depth else []
        sh(self.tmp, "git", "clone", "--quiet", *extra, f"file://{self.origin}", str(self.root))
        # The machine's own git hooks are not part of what is tested here.
        sh(self.root, "git", "config", "core.hooksPath", ".git/hooks")

    def commit(self, message: str, name: str, email: str) -> None:
        sh(self.root, "git", "add", "--all")
        sh(self.root, "git", "-c", f"user.name={name}", "-c", f"user.email={email}",
           "commit", "--quiet", "-m", message)

    def main_moves(self) -> None:
        self.to_main()
        stamp = self.root / "other.txt"
        stamp.write_text(stamp.read_text() + "x\n" if stamp.exists() else "x\n")
        self.commit("other", *HUMAN)
        sh(self.root, "git", "push", "--quiet", "origin", "HEAD:refs/heads/main")

    def to_main(self, at: str = "origin/main") -> None:
        sh(self.root, "git", "fetch", "--quiet", "origin")
        sh(self.root, "git", "switch", "--quiet", "--detach", at)

    def run(self, at: str = "origin/main", **extra: str) -> tuple[int, list[list[str]], str]:
        if at:
            self.to_main(at)
        self.log.write_text("")
        step = self.temp / "summary.md"
        step.write_text("")
        values = {"PATH": self.path, "FAKE_GH_LOG": str(self.log), "RUNNER_TEMP": str(self.temp),
                  "GITHUB_STEP_SUMMARY": str(step), "GITHUB_REPOSITORY": "owner/repo",
                  "FAKE_BUMP_TO": "", "FAKE_GH_PRS": "", "FAKE_GH_RUNS": "1",
                  "FAKE_BUMP_EXIT": "", "FAKE_GH_CREATE_FAILS": ""}
        values.update(extra)
        with env(**values), contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(io.StringIO()):
            try:
                code = pins_drift.open_pr(self.root, [sys.executable, str(self.bump)])
            except pins_drift.Failed:
                code = -1
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        return code, calls, step.read_text()

    def branch(self) -> str:
        return sh(self.root, "git", "ls-remote", "origin", "refs/heads/pins/bump").split("\t")[0]

    def rev(self, ref: str) -> str:
        sh(self.root, "git", "fetch", "--quiet", "origin")
        return sh(self.root, "git", "rev-parse", ref)

    def add_to_branch(self, name: str, email: str) -> None:
        sh(self.root, "git", "fetch", "--quiet", "origin", "refs/heads/pins/bump:refs/remotes/origin/pins/bump")
        sh(self.root, "git", "switch", "--quiet", "--detach", "origin/pins/bump")
        (self.root / "CHANGELOG.md").write_text("- tool\n")
        self.commit("changelog", name, email)
        sh(self.root, "git", "push", "--quiet", "origin", "HEAD:refs/heads/pins/bump")


def names(calls: list[list[str]]) -> list[str]:
    return [" ".join(c[:2]) for c in calls]


def prs(*items: tuple, fork: str = "", author: str = "github-actions[bot]") -> str:
    """Pull requests as the REST API lists them; `fork` names another owner
    whose branch is also called pins/bump."""
    owner = fork or "owner"
    return json.dumps([{"_head": f"{owner}:pins/bump", "number": n,
                        "state": "open" if state == "OPEN" else "closed",
                        "merged_at": "2026-11-12T00:00:00Z" if state == "MERGED" else None,
                        "body": text, "sha": head, "head_repo": f"{owner}/repo", "user": author}
                       for n, state, head, text in items])


def bump_body(to: str) -> str:
    return f"- TOOL_VERSION: 1.0.0 → {to} — `pins.txt`, npm tool\n"


def test_open_pr() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        repo = Repo(pathlib.Path(tmp))

        code, calls, text = repo.run()
        check("no drift left: nothing pushed, no pull request",
              code == 0 and names(calls) == [] and not repo.branch(), f"{code} {calls}")

        code, calls, text = repo.run(FAKE_BUMP_EXIT="2")
        check("bump that cannot read an upstream fails", code == 2 and calls == [], f"{code} {calls}")

        code, calls, text = repo.run(FAKE_BUMP_TO="1.1.0")
        first = repo.branch()
        check("drift on main: the branch is pushed", bool(first))
        check("drift on main: pull request created, then CI dispatched on the branch",
              names(calls) == ["api --paginate", "pr create", "workflow run"], str(names(calls)))
        check("CI dispatch names ci.yml on pins/bump",
              calls[-1] == ["workflow", "run", "ci.yml", "--ref", "pins/bump"], str(calls[-1:]))
        check("open-pr exits 0 (main stays green)", code == 0)
        check("summary names the pull request", "#77" in text, text)
        made = sh(repo.root, "git", "log", "-1", "--format=%ae %ce %s%n%b", first)
        check("the commit is the workflow's own identity",
              made.startswith(f"{pins_drift.BOT_EMAIL} {pins_drift.BOT_EMAIL} {pins_drift.TITLE}"), made)
        check("the commit lists the version, not its checksum",
              "TOOL_VERSION: 1.0.0 → 1.1.0" in made and "TOOL_SHA256" not in made, made)
        check("the commit sits on main", repo.rev(f"{first}^") == repo.rev("origin/main"))
        body = next(c for c in calls if c[:2] == ["pr", "create"])
        check("pull request body lists the move", "TOOL_VERSION: 1.0.0 → 1.1.0" in body[body.index("--body") + 1])

        open77 = prs((77, "OPEN", first, bump_body("1.1.0")))
        code, calls, text = repo.run(FAKE_BUMP_TO="1.1.0", FAKE_GH_PRS=open77)
        check("same bump again, CI already on it: branch untouched, pull request edited, no dispatch",
              repo.branch() == first and names(calls) == ["api --paginate", "pr edit", "api repos/owner/repo/actions/workflows/ci.yml/runs?head_sha=" + first],
              f"{names(calls)}")

        code, calls, text = repo.run(FAKE_BUMP_TO="1.1.0", FAKE_GH_PRS=open77, FAKE_GH_RUNS="0")
        check("same bump again, no CI run on its head: CI is dispatched",
              repo.branch() == first and names(calls)[-1] == "workflow run", f"{names(calls)}")

        code, calls, text = repo.run(FAKE_BUMP_TO="1.2.0", FAKE_GH_PRS=open77)
        second = repo.branch()
        check("a newer upstream: the one branch moves (not a second pull request)",
              second != first and names(calls) == ["api --paginate", "pr edit", "workflow run"], f"{names(calls)}")

        # main moves on several times, and the run sees it through a depth-1 clone.
        for _ in range(3):
            repo.main_moves()
        repo.clone(depth=1)
        open77 = prs((77, "OPEN", second, bump_body("1.2.0")))
        code, calls, text = repo.run(at="", FAKE_BUMP_TO="1.2.0", FAKE_GH_PRS=open77)
        third = repo.branch()
        check("main moved, shallow clone: the branch is rebuilt on main, not taken for a person's",
              code == 0 and third != second and repo.rev(f"{third}^") == repo.rev("origin/main"),
              f"{code} {text}")

        # An older run of main arrives after the branch was built on a newer one.
        older = repo.rev("origin/main^")
        open77 = prs((77, "OPEN", third, bump_body("1.2.0")))
        code, calls, text = repo.run(at=older, FAKE_BUMP_TO="1.2.0", FAKE_GH_PRS=open77)
        check("an older run of main does not rewind a branch built on a newer one",
              code == 0 and repo.branch() == third and "newer main" in text, f"{code} {text}")

        # A person adds a commit: the workflow leaves the branch alone.
        repo.add_to_branch(*HUMAN)
        held = repo.branch()
        open77 = prs((77, "OPEN", held, bump_body("1.2.0")))
        code, calls, text = repo.run(FAKE_BUMP_TO="1.3.0", FAKE_GH_PRS=open77)
        check("a maintainer's commit on the branch: left as it is, green",
              code == 0 and repo.branch() == held and names(calls) == ["api --paginate"], f"{code} {calls}")

        # That pull request merged: the branch is spent, a new drift rebuilds it.
        merged = prs((77, "MERGED", held, bump_body("1.2.0")))
        code, calls, text = repo.run(FAKE_BUMP_TO="1.3.0", FAKE_GH_PRS=merged)
        check("a merged pull request's branch is rebuilt for the next drift, with a new pull request",
              code == 0 and repo.branch() != held and names(calls) == ["api --paginate", "pr create", "workflow run"],
              f"{code} {names(calls)}")

        # Closed without merging: the same bump is not offered again; a different one is.
        fourth = repo.branch()
        declined = prs((78, "CLOSED", fourth, bump_body("1.3.0")))
        code, calls, text = repo.run(FAKE_BUMP_TO="1.3.0", FAKE_GH_PRS=declined)
        check("a closed, unmerged pull request with exactly this bump is not reopened",
              code == 0 and repo.branch() == fourth and names(calls) == ["api --paginate"] and "#78" in text,
              f"{code} {names(calls)} {text}")
        code, calls, text = repo.run(FAKE_BUMP_TO="1.4.0", FAKE_GH_PRS=declined)
        check("a newer bump after a declined one gets its own pull request",
              code == 0 and repo.branch() != fourth and names(calls) == ["api --paginate", "pr create", "workflow run"],
              f"{code} {names(calls)}")

    with tempfile.TemporaryDirectory() as tmp:
        repo = Repo(pathlib.Path(tmp))
        # Someone else's pull requests from a branch that is also called pins/bump.
        theirs = json.loads(prs((90, "OPEN", "f" * 40, "x"), fork="forker")) + \
            json.loads(prs((91, "CLOSED", "e" * 40, bump_body("1.1.0")), fork="forker")) + \
            json.loads(prs((92, "OPEN", "d" * 40, "y"), author="someone"))
        code, calls, text = repo.run(FAKE_BUMP_TO="1.1.0", FAKE_GH_PRS=json.dumps(theirs))
        check("a fork's or a person's pull request named pins/bump is neither edited nor a verdict",
              code == 0 and names(calls) == ["api --paginate", "pr create", "workflow run"], f"{code} {names(calls)}")

    with tempfile.TemporaryDirectory() as tmp:
        repo = Repo(pathlib.Path(tmp))
        code, calls, text = repo.run(FAKE_BUMP_TO="1.1.0", FAKE_GH_CREATE_FAILS="1")
        pushed = repo.branch()
        check("a pull request that cannot be created fails the step", code == -1 and bool(pushed), f"{code}")
        code, calls, text = repo.run(FAKE_BUMP_TO="1.1.0")
        check("the next run creates it and starts its CI, though the branch did not move",
              code == 0 and repo.branch() == pushed and names(calls) == ["api --paginate", "pr create", "workflow run"],
              f"{code} {names(calls)}")

    with tempfile.TemporaryDirectory() as tmp:
        repo = Repo(pathlib.Path(tmp))
        repo.run(FAKE_BUMP_TO="1.1.0")
        raced: list[str] = []
        real_run = pins_drift.run

        def racing_run(*cmd: str, cwd: pathlib.Path, check: bool = True):
            # The first push loses a race: another run of main writes the branch
            # (a bot commit on the same main) just before it lands.
            if cmd[:2] == ("git", "push") and not raced:
                base = sh(cwd, "git", "rev-parse", "HEAD^")
                other = sh(cwd, "git", "-c", f"user.name={pins_drift.BOT_NAME}",
                           "-c", f"user.email={pins_drift.BOT_EMAIL}",
                           "commit-tree", "-p", base, "-m", "race", f"{base}^{{tree}}")
                sh(cwd, "git", "push", "--quiet", "--force", "origin", f"{other}:refs/heads/pins/bump")
                raced.append(other)
            return real_run(*cmd, cwd=cwd, check=check)

        open77 = prs((77, "OPEN", repo.branch(), bump_body("1.1.0")))
        pins_drift.run = racing_run
        try:
            code, calls, text = repo.run(FAKE_BUMP_TO="1.2.0", FAKE_GH_PRS=open77)
        finally:
            pins_drift.run = real_run
        won = repo.branch()
        check("the branch moving under the push: read again and written, not failed",
              code == 0 and bool(raced) and won not in ("", raced[0])
              and "TOOL_VERSION: 1.0.0 → 1.2.0" in sh(repo.root, "git", "log", "-1", "--format=%b", won),
              f"{code} raced={raced} won={won[:8]}")


def main() -> None:
    test_verdict()
    test_open_pr()
    if FAILURES:
        print(f"{len(FAILURES)} failure(s)")
        sys.exit(1)
    print("all pins_drift tests passed")


if __name__ == "__main__":
    main()
