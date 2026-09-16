#!/usr/bin/env python3
"""Self-test for pins.py — offline: every upstream answer is scripted.

What matters most is what the script refuses to call "up to date": an upstream
it could not read, an answer that is not a version, a pin nobody declared a
source for. Those are asserted first-class next to the bump itself.

Run: python3 .github/scripts/test_pins.py
"""

from __future__ import annotations

import contextlib
import io
import json
import pathlib
import subprocess
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import pins  # noqa: E402

REPO = pathlib.Path(__file__).resolve().parents[2]
OLD_X64, OLD_ARM = "a" * 64, "b" * 64
NEW_X64, NEW_ARM = "c" * 64, "d" * 64
BASE = "https://dl.example/releases"

DOCKERFILE = f"""FROM scratch
# upstream: nodejs lts-ready
ARG NODE_VERSION=26.8.1
# upstream: claude-code CLAUDE_DOWNLOAD_BASE latest
ARG CLAUDE_CODE_VERSION=2.1.263
# upstream: claude-code-sha256 linux-x64
ARG CLAUDE_CODE_SHA256_AMD64={OLD_X64}
# upstream: claude-code-sha256 linux-arm64
ARG CLAUDE_CODE_SHA256_ARM64={OLD_ARM}
ARG CLAUDE_DOWNLOAD_BASE={BASE}
# upstream: npm ccstatusline
ARG CCSTATUSLINE_VERSION=2.2.29
# upstream: pypi hass-mcp
ARG HASS_MCP_VERSION=0.6.0
"""
BUILD = """build_from:
  # upstream: github-release hassio-addons/addon-debian-base
  amd64: ghcr.io/hassio-addons/debian-base:9.4.0
"""


def manifest(x64: str, arm: str) -> bytes:
    return json.dumps({"platforms": {"linux-x64": {"checksum": x64}, "linux-arm64": {"checksum": arm}}}).encode()


def answers(**over) -> dict[str, bytes]:
    base = {
        "https://nodejs.org/dist/index.json": json.dumps([
            {"version": "v27.0.0", "lts": False},
            {"version": "v26.8.1", "lts": False},
            {"version": "v24.9.0", "lts": "Krypton"},
        ]).encode(),
        f"{BASE}/latest": b"2.1.263\n",
        f"{BASE}/2.1.263/manifest.json": manifest(OLD_X64, OLD_ARM),
        f"{BASE}/2.1.272/manifest.json": manifest(NEW_X64, NEW_ARM),
        "https://registry.npmjs.org/ccstatusline/latest": b'{"version": "2.2.29"}',
        "https://pypi.org/pypi/hass-mcp/json": b'{"info": {"version": "0.6.0"}}',
        "https://api.github.com/repos/hassio-addons/addon-debian-base/releases/latest": b'{"tag_name": "v9.4.0"}',
    }
    base.update(over)
    return base


def repo(dockerfile: str = DOCKERFILE, build: str = BUILD) -> pathlib.Path:
    root = pathlib.Path(tempfile.mkdtemp())
    (root / "addon").mkdir()
    (root / "addon" / "Dockerfile").write_text(dockerfile)
    (root / "addon" / "build.yaml").write_text(build)
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    subprocess.run(["git", "-C", str(root), "add", "-A"], check=True)
    return root


def run(root: pathlib.Path, table: dict[str, bytes], *argv: str) -> tuple[int, str]:
    def fetch(url: str) -> bytes:
        if url not in table:
            raise pins.PinError(f"could not read {url}: offline")
        return table[url]

    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        code = pins.main(list(argv), upstream=pins.Upstream(fetch), root=root)
    return code, out.getvalue()


fails = 0


def check(label: str, got, want) -> None:
    global fails
    if got == want:
        print(f"  ok  - {label}")
    else:
        print(f"  NOT ok - {label} (got {got!r}, want {want!r})")
        fails += 1


print("check")
code, out = run(repo(), answers(), "check")
check("every pin current -> exit 0", code, 0)
check("node does not jump to a major that is not LTS-ready", "behind   NODE" in out, False)

code, out = run(repo(), answers(**{"https://registry.npmjs.org/ccstatusline/latest": b'{"version": "2.3.0"}'}), "check")
check("a stale pin -> exit 1", code, 1)
check("the stale pin is named with both versions", "CCSTATUSLINE_VERSION" in out and "2.2.29 -> 2.3.0" in out, True)

table = answers()
del table["https://pypi.org/pypi/hass-mcp/json"]
code, out = run(repo(), table, "check")
check("an unreadable upstream fails closed (exit 2, not 0)", code, 2)

def run_safely(table: dict[str, bytes]) -> tuple[object, str]:
    """Like run(), but an exception escaping main() is the result, not a crash."""
    try:
        return run(repo(), table, "check")
    except Exception as err:  # noqa: BLE001 — the escape itself is what is asserted
        return type(err).__name__, ""


for label, url, body in [
    ("pypi answer without info.version", "https://pypi.org/pypi/hass-mcp/json", b'{"info": {}}'),
    ("pypi answer that is a list", "https://pypi.org/pypi/hass-mcp/json", b'["0.6.0"]'),
    ("npm answer without version", "https://registry.npmjs.org/ccstatusline/latest", b'{"name": "ccstatusline"}'),
    ("GitHub answer that is a string",
     "https://api.github.com/repos/hassio-addons/addon-debian-base/releases/latest", b'"v9.4.0"'),
    ("Node.js index with a release that is not an object", "https://nodejs.org/dist/index.json", b'["v26.8.1"]'),
    ("manifest whose platforms is a list", f"{BASE}/2.1.263/manifest.json", b'{"platforms": []}'),
    ("npm version that is a number", "https://registry.npmjs.org/ccstatusline/latest", b'{"version": 2}'),
    ("npm version that is a larger number", "https://registry.npmjs.org/ccstatusline/latest", b'{"version": 3}'),
    ("GitHub tag that is a number",
     "https://api.github.com/repos/hassio-addons/addon-debian-base/releases/latest", b'{"tag_name": 9.4}'),
    ("pypi version that is null", "https://pypi.org/pypi/hass-mcp/json", b'{"info": {"version": null}}'),
    ("checksum that is a number", f"{BASE}/2.1.263/manifest.json",
     json.dumps({"platforms": {"linux-x64": {"checksum": int("1" * 64)}, "linux-arm64": {"checksum": OLD_ARM}}}).encode()),
    ("Node.js release whose version is a number", "https://nodejs.org/dist/index.json",
     b'[{"version": 26, "lts": false}]'),
]:
    code, out = run_safely(answers(**{url: body}))
    check(f"{label} -> exit 2", code, 2)
    check(f"{label} -> the upstream is named", url in out, True)

code, _ = run(repo(), answers(**{f"{BASE}/latest": b"<html>maintenance</html>"}), "check")
check("an answer that is not a version fails closed", code, 2)

code, _ = run(repo(), answers(**{f"{BASE}/2.1.263/manifest.json": manifest(OLD_X64, "zz")}), "check")
check("a manifest checksum that is not SHA-256 fails closed", code, 2)

code, out = run(repo(), answers(**{f"{BASE}/2.1.263/manifest.json": manifest(NEW_X64, OLD_ARM)}), "check")
check("a checksum that no longer matches the pinned version is reported", (code, "CLAUDE_CODE_SHA256_AMD64" in out), (1, True))

code, out = run(repo(DOCKERFILE + "ARG YQ_VERSION=4.0.0\n"), answers(), "check")
check("a version ARG with no upstream marker is refused", (code, "YQ_VERSION" in out or "pinned without" in out), (2, True))

code, _ = run(repo(build=BUILD + "  aarch64: ghcr.io/hassio-addons/debian-base:9.4.0\n"), answers(), "check")
check("a base image tag with no upstream marker is refused", code, 2)

code, _ = run(repo(DOCKERFILE + "# upstream: npm left-pad\n# a comment\n"), answers(), "check")
check("a marker not followed by a pinned line is refused", code, 2)

code, _ = run(repo(DOCKERFILE + "# upstream: cargo ripgrep\nARG RG_VERSION=14.0.0\n"), answers(), "check")
check("an unknown upstream kind is refused", code, 2)

code, _ = run(repo("FROM scratch\n", "build_from: {}\n"), answers(), "check")
check("no markers at all is an error, not 'nothing stale'", code, 2)

print("node policy")
lts28 = json.dumps([
    {"version": "v28.1.0", "lts": "Next"}, {"version": "v27.3.0", "lts": False}, {"version": "v26.9.0", "lts": False},
]).encode()
code, out = run(repo(), answers(**{"https://nodejs.org/dist/index.json": lts28}), "check")
check("a newer major that has had an LTS release is taken", "26.8.1 -> 28.1.0" in out, True)
same = json.dumps([{"version": "v27.0.0", "lts": False}, {"version": "v26.9.0", "lts": False}]).encode()
code, out = run(repo(), answers(**{"https://nodejs.org/dist/index.json": same}), "check")
check("otherwise the newest release on the pinned major line", "26.8.1 -> 26.9.0" in out, True)

print("bump")
root = repo()
summary = root / "summary.json"
code, out = run(root, answers(**{
    f"{BASE}/latest": b"2.1.272",
    "https://registry.npmjs.org/ccstatusline/latest": b'{"version": "3.0.0"}',
}), "bump", "--summary", str(summary))
text = (root / "addon" / "Dockerfile").read_text()
check("bump exits 0", code, 0)
check("the Claude version moves", "ARG CLAUDE_CODE_VERSION=2.1.272\n" in text, True)
check("its checksums move to the NEW version's manifest", (f"AMD64={NEW_X64}\n" in text, f"ARM64={NEW_ARM}\n" in text), (True, True))
check("an npm pin moves", "ARG CCSTATUSLINE_VERSION=3.0.0\n" in text, True)
check("an untouched pin and the markers stay byte-identical", ("ARG HASS_MCP_VERSION=0.6.0\n" in text, text.count("# upstream:")), (True, 6))
changes = json.loads(summary.read_text())
check("the summary lists four moves", sorted(c["name"] for c in changes),
      ["CCSTATUSLINE_VERSION", "CLAUDE_CODE_SHA256_AMD64", "CLAUDE_CODE_SHA256_ARM64", "CLAUDE_CODE_VERSION"])
check("a major move is flagged", {c["name"]: c["major"] for c in changes}["CCSTATUSLINE_VERSION"], True)
code, out = run(root, answers(**{
    f"{BASE}/latest": b"2.1.272",
    "https://registry.npmjs.org/ccstatusline/latest": b'{"version": "3.0.0"}',
}), "check")
check("after a bump, check agrees everything is current", code, 0)

print("this repository")
found = pins.discover(REPO)
check("every pin in the add-on declares an upstream (no unmarked pin)", len(found) > 0, True)
check("the Claude checksums have their version pin beside them",
      sum(1 for p in found if p.kind == "claude-code-sha256"), 2)

if fails:
    print(f"{fails} failure(s)")
    sys.exit(1)
print("all passed")
