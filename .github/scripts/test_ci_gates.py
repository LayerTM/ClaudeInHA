#!/usr/bin/env python3
"""Self-test for ci_gates.py — the check that the release waits for every gate.

Its whole value is in what it REFUSES: a checker that answers "complete" for any
workflow would keep the release job's needs list looking maintained while a new
gate went unwaited-for. So every way the list can be wrong is asserted here, in
both directions, and the repository's own workflow is checked last.

Run: python3 .github/scripts/test_ci_gates.py
"""

from __future__ import annotations

import pathlib
import re
import subprocess
import sys
import tempfile

SCRIPT = pathlib.Path(__file__).resolve().parent / "ci_gates.py"
REPO = SCRIPT.parents[2]
WORKFLOW = REPO / ".github/workflows/ci.yml"

COMPLETE = """name: ci
on: [push]
jobs:
  alpha:
    runs-on: ubuntu-latest
    steps: [{run: "true"}]
  beta:
    runs-on: ubuntu-latest
    steps: [{run: "true"}]
  release:
    needs: [alpha, beta]
    runs-on: ubuntu-latest
    steps: [{run: "true"}]
"""

fails = 0


def check(label: str, got, want) -> None:
    global fails
    if got == want:
        print(f"  ok  - {label}")
    else:
        print(f"  NOT ok - {label} (got {got!r}, want {want!r})")
        fails += 1


def run(text: str | None, name: str = "ci.yml"):
    """Run the checker over a workflow, or over a path that does not exist."""
    with tempfile.TemporaryDirectory() as tmp:
        path = pathlib.Path(tmp) / name
        if text is not None:
            path.write_text(text, encoding="utf-8")
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(path)],
            capture_output=True,
            text=True,
        )


print("A complete list is accepted")
done = run(COMPLETE)
check("exit code", done.returncode, 0)
check("says nothing", done.stderr.strip(), "")

print("A gate the release does not wait for is refused")
done = run(COMPLETE.replace("needs: [alpha, beta]", "needs: [alpha]"))
check("exit code", done.returncode, 1)
check("names the job left out", "'beta'" in done.stderr, True)
check("does not name the one that is there", "'alpha' is a gate" in done.stderr, False)

print("A gate added below the release job is refused too")
done = run(COMPLETE + """  gamma:
    runs-on: ubuntu-latest
    steps: [{run: "true"}]
""")
check("exit code", done.returncode, 1)
check("names the new job", "'gamma'" in done.stderr, True)

print("A need that is not a job in the file is refused")
done = run(COMPLETE.replace("needs: [alpha, beta]", "needs: [alpha, beta, ghost]"))
check("exit code", done.returncode, 1)
check("names the ghost", "'ghost'" in done.stderr, True)

print("A single gate written as a string is understood")
done = run("""name: ci
on: [push]
jobs:
  alpha:
    runs-on: ubuntu-latest
    steps: [{run: "true"}]
  release:
    needs: alpha
    runs-on: ubuntu-latest
    steps: [{run: "true"}]
""")
check("exit code", done.returncode, 0)

print("A release job with no needs at all is refused")
done = run(COMPLETE.replace("    needs: [alpha, beta]\n", ""))
check("exit code", done.returncode, 1)
check("names both gates", "'alpha'" in done.stderr and "'beta'" in done.stderr, True)

print("An image step with a network is refused")
IMAGE_STEP = COMPLETE.replace(
    '  beta:\n    runs-on: ubuntu-latest\n    steps: [{run: "true"}]\n',
    "  beta:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n"
    "          docker run --rm {flags}\\\n"
    "            --entrypoint bash some-image /run-this.sh\n",
)
check("the fixture has the step", "docker run" in IMAGE_STEP, True)
done = run(IMAGE_STEP.replace("{flags}", ""))
check("exit code", done.returncode, 1)
check("says what is wrong", "with a network" in done.stderr, True)
done = run(IMAGE_STEP.replace("{flags}", "--network none "))
check("none is accepted", done.returncode, 0)
done = run(IMAGE_STEP.replace("{flags}", "\\\n            --network none "))
check("none on a continuation line is accepted", done.returncode, 0)
done = run(IMAGE_STEP.replace("{flags}", "--network host "))
check("another network is refused", done.returncode, 1)

print("A workflow with no release job is refused, not passed over")
done = run(COMPLETE.replace("  release:\n", "  publish:\n"))
check("exit code", done.returncode, 1)
check("says the check has no subject", "no 'release' job" in done.stderr, True)

print("A missing file is refused rather than read as empty")
done = run(None)
check("exit code", done.returncode, 1)
check("says it is missing", "is missing" in done.stderr, True)

print("A file that is not a workflow is refused")
done = run("just a string\n")
check("exit code", done.returncode, 1)
check("says it has no jobs", "no jobs mapping" in done.stderr, True)

print("A curl that retries must retry every error, not only the transient HTTP ones")
sys.path.insert(0, str(SCRIPT.parent))
from ci_gates import curl_retry_complaints  # noqa: E402

BAD = "curl -fsSL --retry 3 --retry-delay 2 -o /f https://x/y"
check("--retry alone is refused", len(curl_retry_complaints("f", BAD)), 1)
check("--retry-all-errors is accepted", curl_retry_complaints("f", BAD.replace("--retry 3", "--retry 3 --retry-all-errors")), [])
check("no --retry is not this rule", curl_retry_complaints("f", "curl -fsSL -o /f https://x/y"), [])
check("--retry-delay alone is not --retry", curl_retry_complaints("f", "curl -fsSL --retry-delay 2 https://x/y"), [])
check("a continuation line is one command", len(curl_retry_complaints("f", "RUN curl -fsSL --retry 3 \\\n    -o /f https://x/y")), 1)
check("a flag on a continuation line counts", curl_retry_complaints("f", "RUN curl -fsSL --retry 3 \\\n    --retry-all-errors -o /f https://x/y"), [])
check("each curl in a && chain is judged alone", len(curl_retry_complaints("f", "curl --retry 3 --retry-all-errors a && curl --retry 3 b")), 1)

print("This repository's own workflow")
done = subprocess.run(
    [sys.executable, str(SCRIPT), str(WORKFLOW)], capture_output=True, text=True
)
check("exit code", done.returncode, 0)
check("says nothing", done.stderr.strip(), "")

# canary.yml calls this workflow with canary: true. A release cut from a run
# whose every pin was moved to its latest would ship what main never carried.
print("The release job never runs for the canary build")
release_if = re.search(r"^  release:\n(?:.*\n)*?    if: >-\n((?:      .*\n)+)", WORKFLOW.read_text(encoding="utf-8"), re.MULTILINE)
check("release job has an if", release_if is not None, True)
check("it excludes canary", release_if is not None and "!inputs.canary" in release_if.group(1), True)

print(f"\n{'FAILED' if fails else 'ok'} — {fails} failing check(s)")
sys.exit(1 if fails else 0)
