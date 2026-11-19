#!/usr/bin/env python3
"""Self-test for claude-code/build-tools/apt-install.sh — offline, with a recording apt-get.

What matters: every apt call reads the pinned snapshot, an expired snapshot
cannot silently drop a suite (Check-Valid-Until off, --error-on=any on the
index update), a failed index update never reaches the install, and nothing a
build leaves behind that changes from one run to the next survives the layer.

Run: python3 .github/scripts/test_apt_install.py
"""

from __future__ import annotations

import os
import pathlib
import subprocess
import sys
import tempfile

HELPER = pathlib.Path(__file__).resolve().parents[2] / "claude-code" / "build-tools" / "apt-install.sh"
SNAP = "20261119T144258Z"
fails = 0


def check(label: str, got, want) -> None:
    global fails
    if got == want:
        print(f"  ok  - {label}")
    else:
        fails += 1
        print(f"  FAIL - {label}: got {got!r}, want {want!r}")


def run(snapshot: str | None = SNAP, fail_on: str = "", args: tuple[str, ...] = ("curl", "jq")):
    """Run the helper against a fake root; returns (exit code, recorded apt calls, root)."""
    root = pathlib.Path(tempfile.mkdtemp())
    for name in ("var/lib/apt/lists/x_InRelease", "var/cache/apt/pkgcache.bin", "var/log/apt/term.log",
                 "var/log/dpkg.log", "var/log/alternatives.log", "var/cache/ldconfig/aux-cache",
                 "var/cache/debconf/config.dat-old", "var/lib/dpkg/status-old",
                 "etc/machine-id", "var/lib/dbus/machine-id", "var/lib/dpkg/status"):
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text("state\n")
    bin_dir = root / "bin"
    bin_dir.mkdir()
    log = root / "calls.log"
    fake = bin_dir / "apt-get"
    fake.write_text(f"""#!/bin/bash
echo "$*" >> {log}
case " $* " in *" {fail_on} "*) [ -n "{fail_on}" ] && exit 100;; esac
exit 0
""")
    fake.chmod(0o755)
    env = {"PATH": f"{bin_dir}:{os.environ['PATH']}", "APT_INSTALL_ROOT": str(root)}
    if snapshot:
        env["DEBIAN_SNAPSHOT"] = snapshot
    run = subprocess.run(["bash", str(HELPER), *args], env=env, capture_output=True, text=True, check=False)
    calls = log.read_text().splitlines() if log.exists() else []
    return run.returncode, calls, root


code, calls, root = run()
check("a clean run succeeds", code, 0)
check("exactly an index update, then an install",
      ["update" if " update " in c else "install" if " install " in c else c for c in calls], ["update", "install"])
check("every call reads the pinned snapshot", all(f"APT::Snapshot={SNAP}" in c for c in calls), True)
check("the expired-snapshot trap: Valid-Until is off for the pinned snapshot", all("Acquire::Check-Valid-Until=false" in c for c in calls), True)
check("the expired-snapshot trap: an index error fails the build (apt otherwise exits 0)", "--error-on=any" in calls[0], True)
check("the install is the named packages only, without recommends", "install -y --no-install-recommends curl jq" in calls[1], True)
left = sorted(str(p.relative_to(root)) for p in root.rglob("*") if p.is_file() and p.parent.name != "bin"
              and p.name != "calls.log")
check("what a build leaves behind is gone, the package database stays", left, ["var/lib/dpkg/status"])

code, calls, _ = run(snapshot=None)
check("no snapshot named -> the build fails before apt runs", (code != 0, calls), (True, []))

code, calls, root = run(fail_on="--error-on=any")
check("a failed index update stops the build", code != 0, True)
check("... and nothing is installed from an index that did not load", any("install" in c for c in calls), False)

print(f"\n{'FAILED' if fails else 'ok'} — {fails} failing check(s)")
sys.exit(1 if fails else 0)
