#!/usr/bin/env python3
"""Self-test for addon_arches.py — the script CI derives its build matrix from.

Its value is entirely in what it REFUSES, so that is what is asserted here: a
matrix built from a script that answers when the add-on's files disagree would
silently build the wrong set, which is the failure the script exists to prevent.

Run: python3 .github/scripts/test_addon_arches.py
"""

from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

SCRIPT = pathlib.Path(__file__).resolve().parent / "addon_arches.py"
REPO = SCRIPT.parents[2]

BUILD = """build_from:
  amd64: base:1.0
  aarch64: base:1.0
"""
CONFIG = """name: "X"
version: "1.0.0"
arch:
  - aarch64
  - amd64
"""

fails = 0


def check(label: str, got, want) -> None:
    global fails
    if got == want:
        print(f"  ok  - {label}")
    else:
        print(f"  NOT ok - {label} (got {got!r}, want {want!r})")
        fails += 1


def run(tmp: pathlib.Path, *args: str) -> subprocess.CompletedProcess:
    """Run the script against a throwaway add-on directory."""
    scripts = tmp / ".github" / "scripts"
    scripts.mkdir(parents=True, exist_ok=True)
    target = scripts / SCRIPT.name
    # The real-repository case runs the script where it already lives.
    if target.resolve() != SCRIPT:
        shutil.copy(SCRIPT, target)
    return subprocess.run(
        [sys.executable, str(target), *args],
        capture_output=True,
        text=True,
        check=False,
    )


def addon(tmp: pathlib.Path, build: str = BUILD, config: str = CONFIG) -> None:
    d = tmp / "claude-code"
    d.mkdir(parents=True, exist_ok=True)
    (d / "build.yaml").write_text(build, encoding="utf-8")
    (d / "config.yaml").write_text(config, encoding="utf-8")


def main() -> None:
    print("addon_arches — the agreeing case")
    with tempfile.TemporaryDirectory() as raw:
        tmp = pathlib.Path(raw)
        addon(tmp)
        r = run(tmp)
        check("exits 0", r.returncode, 0)
        check("lists both, sorted", r.stdout.strip(), '["aarch64","amd64"]')
        check("is valid JSON for a matrix", json.loads(r.stdout), ["aarch64", "amd64"])
        r = run(tmp, "--build-from", "aarch64")
        check("names the base image", r.stdout.strip(), "base:1.0")

    print("addon_arches — every way the files can disagree is refused")
    cases = {
        "an arch offered with no base image": (
            "build_from:\n  amd64: base:1.0\n", CONFIG),
        "a base image for an arch nobody is offered": (
            BUILD, 'name: "X"\nversion: "1.0.0"\narch:\n  - amd64\n'),
        "config.yaml has no arch list": (BUILD, 'name: "X"\nversion: "1.0.0"\n'),
        "build.yaml has no build_from": ("something_else: 1\n", CONFIG),
    }
    for label, (build, config) in cases.items():
        with tempfile.TemporaryDirectory() as raw:
            tmp = pathlib.Path(raw)
            addon(tmp, build, config)
            r = run(tmp)
            check(f"refuses: {label}", r.returncode != 0, True)
            check(f"  ...and says why: {label}", bool(r.stderr.strip()), True)

    print("addon_arches — an undeclared architecture has no base image")
    with tempfile.TemporaryDirectory() as raw:
        tmp = pathlib.Path(raw)
        addon(tmp)
        r = run(tmp, "--build-from", "riscv64")
        check("refuses an arch it was never given", r.returncode != 0, True)

    print("addon_arches — the real add-on in this repository")
    r = run(REPO)
    check("agrees with itself", r.returncode, 0)
    real = json.loads(r.stdout)
    check("and declares at least one architecture", len(real) >= 1, True)
    print(f"       (this repository declares {real})")

    print()
    if fails:
        print(f"FAIL: {fails} addon_arches check(s) failed")
        sys.exit(1)
    print("PASS: all addon_arches checks passed")


if __name__ == "__main__":
    main()
