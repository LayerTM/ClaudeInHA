#!/usr/bin/env python3
"""Self-test for pins.py — offline: every upstream answer is scripted.

What matters most is what the script refuses to call "up to date": an upstream
it could not read, an answer that is not a version, a pin nobody declared a
source for. Those are asserted first-class next to the bump itself.

Run: python3 .github/scripts/test_pins.py
"""

from __future__ import annotations

import contextlib
import email.message
import http.client
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import urllib.error

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import pins  # noqa: E402

REPO = pathlib.Path(__file__).resolve().parents[2]
OLD_X64, OLD_ARM = "a" * 64, "b" * 64
NEW_X64, NEW_ARM = "c" * 64, "d" * 64
BASE = "https://dl.example/releases"
NODE_OLD_X64, NODE_OLD_ARM = "1" * 64, "2" * 64
NODE_NEW_X64, NODE_NEW_ARM = "3" * 64, "4" * 64
NODE_SUMS = "https://nodejs.org/dist/v{}/SHASUMS256.txt"

DOCKERFILE = f"""FROM scratch
# upstream: nodejs lts-ready
ARG NODE_VERSION=26.8.1
# upstream: nodejs-sha256 linux-x64
ARG NODE_SHA256_AMD64={NODE_OLD_X64}
# upstream: nodejs-sha256 linux-arm64
ARG NODE_SHA256_ARM64={NODE_OLD_ARM}
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


def shasums(version: str, x64: str, arm: str) -> bytes:
    return (f"{x64}  node-v{version}-linux-x64.tar.xz\n"
            f"{x64}  node-v{version}-linux-x64.tar.gz\n"
            f"{arm}  node-v{version}-linux-arm64.tar.xz\n"
            f"{'9' * 64}  node-v{version}-linux-arm64-musl.tar.xz\n").encode()


def answers(**over) -> dict[str, bytes]:
    base = {
        "https://nodejs.org/dist/index.json": json.dumps([
            {"version": "v27.0.0", "lts": False},
            {"version": "v26.8.1", "lts": False},
            {"version": "v24.9.0", "lts": "Krypton"},
        ]).encode(),
        NODE_SUMS.format("26.8.1"): shasums("26.8.1", NODE_OLD_X64, NODE_OLD_ARM),
        NODE_SUMS.format("26.9.0"): shasums("26.9.0", NODE_NEW_X64, NODE_NEW_ARM),
        f"{BASE}/latest": b"2.1.263\n",
        f"{BASE}/2.1.263/manifest.json": manifest(OLD_X64, OLD_ARM),
        f"{BASE}/2.1.272/manifest.json": manifest(NEW_X64, NEW_ARM),
        "https://registry.npmjs.org/ccstatusline/latest": b'{"version": "2.2.29"}',
        "https://pypi.org/pypi/hass-mcp/json": b'{"info": {"version": "0.6.0"}}',
        "https://api.github.com/repos/hassio-addons/addon-debian-base/releases/latest": b'{"tag_name": "v9.4.0"}',
    }
    base.update(over)
    return base


TOOLS = """{
  "name": "tools",
  "private": true,
  "dependencies": {
    "@playwright/mcp": "0.0.81",
    "ccstatusline": "2.2.29"
  }
}
"""


def repo(dockerfile: str = DOCKERFILE, build: str = BUILD, files: dict[str, str] | None = None) -> pathlib.Path:
    root = pathlib.Path(tempfile.mkdtemp())
    (root / "addon").mkdir()
    (root / "addon" / "Dockerfile").write_text(dockerfile)
    (root / "addon" / "build.yaml").write_text(build)
    for name, body in (files or {}).items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text(body)
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    subprocess.run(["git", "-C", str(root), "add", "-A"], check=True)
    return root


relocked: list[pathlib.Path] = []


def record_relock(directory: pathlib.Path, root: pathlib.Path) -> None:
    relocked.append(directory.relative_to(root))


def run(root: pathlib.Path, table: dict[str, bytes], *argv: str, relock=record_relock, now: float | None = None) -> tuple[int, str]:
    def fetch(url: str) -> bytes:
        if url not in table:
            raise pins.PinError(f"could not read {url}: offline")
        return table[url]

    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        code = pins.main(list(argv), upstream=pins.Upstream(fetch, **({"clock": lambda: now} if now else {})), root=root, relock=relock)
    return code, out.getvalue()


fails = 0


def check(label: str, got, want) -> None:
    global fails
    if got == want:
        print(f"  ok  - {label}")
    else:
        print(f"  NOT ok - {label} (got {got!r}, want {want!r})")
        fails += 1


print("fetching: only a transient failure is retried, after a wait")


class Reply(io.BytesIO):
    """What urlopen hands back: a readable context manager."""


def fetch_with(*outcomes):
    """Runs http_get against scripted urlopen outcomes -> (result, calls, waits)."""
    script, calls, waits = list(outcomes), [], []

    def urlopen(request, timeout):
        calls.append(request.full_url)
        outcome = script.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return Reply(outcome)

    real = pins.urllib.request.urlopen
    pins.urllib.request.urlopen = urlopen
    try:
        result = pins.http_get("https://registry.example/pkg", sleep=waits.append)
    except pins.PinError as err:
        result = err
    finally:
        pins.urllib.request.urlopen = real
    return result, len(calls), waits


def status(code: int, retry_after: str | None = None) -> urllib.error.HTTPError:
    headers = email.message.Message()
    if retry_after is not None:
        headers["Retry-After"] = retry_after
    return urllib.error.HTTPError("https://registry.example/pkg", code, "scripted", headers, None)


check("429 then 200 -> the value, after the wait Retry-After asked for",
      fetch_with(status(429, "7"), b"v"), (b"v", 2, [7]))
check("a long Retry-After is capped", fetch_with(status(429, "3600"), b"v"), (b"v", 2, [60]))
check("an unreadable Retry-After falls back to the backoff",
      fetch_with(status(503, "soon"), b"v"), (b"v", 2, [2]))
check("a dated Retry-After falls back to the backoff",
      fetch_with(status(503, "Fri, 27 Nov 2026 10:00:00 GMT"), b"v"), (b"v", 2, [2]))
check("5xx, a network error, a timeout and a cut answer are retried with a growing wait",
      fetch_with(status(502), urllib.error.URLError("reset"), TimeoutError("timed out"), b"v"),
      (b"v", 4, [2, 5, 15]))
check("a cut-off body is retried", fetch_with(http.client.IncompleteRead(b""), b"v"), (b"v", 2, [2]))
result, calls, waits = fetch_with(status(404), b"v")
check("a 404 fails at once", (type(result), calls, waits), (pins.PinError, 1, []))
check("the failure names the URL and the answer",
      "https://registry.example/pkg" in str(result) and "404" in str(result), True)
result, calls, waits = fetch_with(*[status(429)] * 4)
check("a failure that does not pass is reported after the last wait",
      (type(result), calls, waits, "429" in str(result)), (pins.PinError, 4, [2, 5, 15], True))

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

code, out = run(repo(), answers(**{NODE_SUMS.format("26.8.1"): shasums("26.8.1", NODE_NEW_X64, NODE_OLD_ARM)}), "check")
check("a Node checksum that no longer matches the pinned version is reported",
      (code, "NODE_SHA256_AMD64" in out), (1, True))

sums = NODE_SUMS.format("26.8.1")
for label, body in [
    ("SHASUMS without the platform's tarball", f"{NODE_OLD_ARM}  node-v26.8.1-linux-arm64.tar.xz\n".encode()),
    ("SHASUMS listing the tarball twice", shasums("26.8.1", NODE_OLD_X64, NODE_OLD_ARM) * 2),
    ("SHASUMS entry that is not a SHA-256", shasums("26.8.1", "zz", NODE_OLD_ARM)),
    ("SHASUMS that is an HTML page", b"<html>not found</html>"),
]:
    code, out = run_safely(answers(**{sums: body}))
    check(f"{label} -> exit 2", code, 2)
    check(f"{label} -> the upstream is named", sums in out, True)

orphan = "FROM scratch\n# upstream: nodejs-sha256 linux-x64\nARG NODE_SHA256_AMD64=" + NODE_OLD_X64 + "\n"
code, out = run(repo(orphan), answers(), "check")
check("a Node checksum with no nodejs pin in its file is refused", (code, "needs exactly one nodejs pin" in out), (2, True))

print("node policy")
lts28 = json.dumps([
    {"version": "v28.1.0", "lts": "Next"}, {"version": "v27.3.0", "lts": False}, {"version": "v26.9.0", "lts": False},
]).encode()
code, out = run(repo(), answers(**{"https://nodejs.org/dist/index.json": lts28,
                                   NODE_SUMS.format("28.1.0"): shasums("28.1.0", NODE_NEW_X64, NODE_NEW_ARM)}), "check")
check("a newer major that has had an LTS release is taken", "26.8.1 -> 28.1.0" in out, True)
same = json.dumps([{"version": "v27.0.0", "lts": False}, {"version": "v26.9.0", "lts": False}]).encode()
code, out = run(repo(), answers(**{"https://nodejs.org/dist/index.json": same}), "check")
check("otherwise the newest release on the pinned major line", "26.8.1 -> 26.9.0" in out, True)

pre = json.dumps([{"version": "v27.0.0-alpha.0.0.0", "lts": False}, {"version": "v27.0.0-rc.1", "lts": "Next"},
                  {"version": "v26.9.0", "lts": False}]).encode()
code, out = run(repo(), answers(**{"https://nodejs.org/dist/index.json": pre}), "check")
check("a pre-release is skipped, even on a new major or marked LTS", (code, "26.8.1 -> 26.9.0" in out), (1, True))
junk = json.dumps([{"version": "vnext", "lts": False}, {"version": "v26.9.0", "lts": False}]).encode()
code, _ = run(repo(), answers(**{"https://nodejs.org/dist/index.json": junk}), "check")
check("a Node.js version that is neither release nor pre-release still fails closed", code, 2)

print("bump")
root = repo()
summary = root / "summary.json"
code, out = run(root, answers(**{
    f"{BASE}/latest": b"2.1.272",
    "https://registry.npmjs.org/ccstatusline/latest": b'{"version": "3.0.0"}',
    "https://nodejs.org/dist/index.json": same,
}), "bump", "--summary", str(summary))
text = (root / "addon" / "Dockerfile").read_text()
check("bump exits 0", code, 0)
check("the Claude version moves", "ARG CLAUDE_CODE_VERSION=2.1.272\n" in text, True)
check("its checksums move to the NEW version's manifest", (f"AMD64={NEW_X64}\n" in text, f"ARM64={NEW_ARM}\n" in text), (True, True))
check("the Node version moves", "ARG NODE_VERSION=26.9.0\n" in text, True)
check("its checksums move to the NEW version's SHASUMS",
      (f"NODE_SHA256_AMD64={NODE_NEW_X64}\n" in text, f"NODE_SHA256_ARM64={NODE_NEW_ARM}\n" in text), (True, True))
check("an npm pin moves", "ARG CCSTATUSLINE_VERSION=3.0.0\n" in text, True)
check("an untouched pin and the markers stay byte-identical", ("ARG HASS_MCP_VERSION=0.6.0\n" in text, text.count("# upstream:")), (True, 8))
changes = json.loads(summary.read_text())
check("the summary lists seven moves", sorted(c["name"] for c in changes),
      ["CCSTATUSLINE_VERSION", "CLAUDE_CODE_SHA256_AMD64", "CLAUDE_CODE_SHA256_ARM64", "CLAUDE_CODE_VERSION",
       "NODE_SHA256_AMD64", "NODE_SHA256_ARM64", "NODE_VERSION"])
check("a major move is flagged", {c["name"]: c["major"] for c in changes}["CCSTATUSLINE_VERSION"], True)
code, out = run(root, answers(**{
    f"{BASE}/latest": b"2.1.272",
    "https://registry.npmjs.org/ccstatusline/latest": b'{"version": "3.0.0"}',
    "https://nodejs.org/dist/index.json": same,
}), "check")
check("after a bump, check agrees everything is current", code, 0)

print("package.json with a lockfile")
LOCKED = {"addon/tools/package.json": TOOLS, "addon/tools/package-lock.json": "{}\n"}
MCP = "https://registry.npmjs.org/@playwright/mcp/latest"
tools = answers(**{MCP: b'{"version": "0.0.81"}'})
code, out = run(repo(files=LOCKED), tools, "check")
check("its dependencies are pins, current -> exit 0", (code, "@playwright/mcp (addon/tools/package.json:5" in out), (0, True))
code, out = run(repo(files=LOCKED), answers(**{MCP: b'{"version": "0.0.82"}'}), "check")
check("a stale dependency is reported", (code, "0.0.81 -> 0.0.82" in out), (1, True))
code, _ = run(repo(files=LOCKED), answers(), "check")
check("an unreadable npm upstream fails closed", code, 2)
code, out = run(repo(files={**LOCKED, "addon/tools/package.json": TOOLS.replace('"2.2.29"', '"^2.2.29"')}), tools, "check")
check("a range is refused", (code, "not an exact version" in out), (2, True))
one_line = '{"name": "t", "dependencies": {"ccstatusline": "2.2.29"}}\n'
code, out = run(repo(files={**LOCKED, "addon/tools/package.json": one_line}), tools, "check")
check("dependencies not one per line are refused", (code, "one \"name\": \"version\" per line" in out), (2, True))
code, out = run(repo(files={"addon/tools/package.json": TOOLS.replace('"2.2.29"', '"^2.2.29"')}), tools, "check")
check("a package.json without a lockfile is not a pin file", code, 0)

relocked.clear()
root = repo(files=LOCKED)
code, out = run(root, answers(**{MCP: b'{"version": "0.0.82"}'}), "bump")
text = (root / "addon" / "tools" / "package.json").read_text()
check("bump exits 0", code, 0)
check("the version moves and the file stays JSON with its layout",
      (text == TOOLS.replace('"0.0.81"', '"0.0.82"'), json.loads(text)["dependencies"]["@playwright/mcp"]), (True, "0.0.82"))
check("its lockfile is refreshed once", relocked, [pathlib.Path("addon/tools")])
relocked.clear()
code, _ = run(repo(files=LOCKED), tools, "bump")
check("nothing stale -> the lockfile is left alone", (code, relocked), (0, []))


def failing_relock(directory: pathlib.Path, root: pathlib.Path) -> None:
    raise pins.PinError("npm could not refresh package-lock.json: offline")


code, out = run(repo(files=LOCKED), answers(**{MCP: b'{"version": "0.0.82"}'}), "bump", relock=failing_relock)
check("a lockfile that cannot be refreshed fails the bump", (code, "could not refresh" in out), (2, True))

print("core.lock.json")
CORE = "https://api.github.com/repos/Example/core/releases/latest"


def lock(version: str, commit: str = "0" * 40) -> str:
    return json.dumps({"lockVersion": 1, "version": version, "commit": commit,
                       "url": f"https://github.com/Example/core/releases/download/v{version}/core-{version}.tar",
                       "sha256": "e" * 64, "adapterApi": 5}, indent=2) + "\n"


def asset(version: str) -> str:
    return f"https://github.com/Example/core/releases/download/v{version}/core.lock.json"


CORE_FILES = {"addon/core/core.lock.json": lock("0.3.0")}
code, out = run(repo(files=CORE_FILES), answers(**{CORE: b'{"tag_name": "v0.3.0"}'}), "check")
check("a current lock -> exit 0, the repository is read from its url",
      (code, "core (addon/core/core.lock.json:3, core-lock Example/core)" in out), (0, True))
code, out = run(repo(files=CORE_FILES), answers(**{CORE: b'{"tag_name": "v0.4.1"}'}), "check")
check("a lock behind the latest release is reported", (code, "0.3.0 -> 0.4.1" in out), (1, True))
code, _ = run(repo(files=CORE_FILES), answers(), "check")
check("an unreadable core upstream fails closed", code, 2)
for label, body in [
    ("a url that is not a release download", lock("0.3.0").replace("github.com", "example.org")),
    ("a url for another version", lock("0.3.0").replace("v0.3.0/", "v0.2.0/")),
    ("a lock that is not JSON", "version: 0.3.0\n"),
]:
    code, _ = run(repo(files={"addon/core/core.lock.json": body}), answers(**{CORE: b'{"tag_name": "v0.3.0"}'}), "check")
    check(f"{label} is refused", code, 2)

root = repo(files=CORE_FILES)
summary = root / "summary.json"
code, out = run(root, answers(**{CORE: b'{"tag_name": "v0.4.1"}', asset("0.4.1"): lock("0.4.1", "1" * 40).encode()}),
                "bump", "--summary", str(summary))
check("bump replaces the lock with the release's own asset",
      (code, (root / "addon/core/core.lock.json").read_text()), (0, lock("0.4.1", "1" * 40)))
check("the summary names the move", [(c["name"], c["from"], c["to"]) for c in json.loads(summary.read_text())],
      [("core", "0.3.0", "0.4.1")])
code, _ = run(repo(files=CORE_FILES), answers(**{CORE: b'{"tag_name": "v0.4.1"}', asset("0.4.1"): lock("0.4.0").encode()}), "bump")
check("an asset that locks another version fails the bump", code, 2)
code, _ = run(repo(files=CORE_FILES), answers(**{CORE: b'{"tag_name": "v0.4.1"}'}), "bump")
check("a release without the asset fails the bump", code, 2)

print("debian snapshot")
SNAP_OLD, SNAP_NEW = "20261101T000000Z", "20261119T144258Z"
SNAP_DOCKERFILE = f"FROM scratch\n# upstream: debian-snapshot\nARG DEBIAN_SNAPSHOT={SNAP_OLD}\n"
LISTING = "https://snapshot.debian.org/archive/{}/?year=2026&month={}"
def listing(*stamps: str) -> bytes:
    return "".join(f'<a href="{s}/">{s}</a>\n' for s in stamps).encode() + b'<a href="../">up</a>'
def snapshots(**over) -> dict[str, bytes]:
    table = {
        "https://api.github.com/repos/hassio-addons/addon-debian-base/releases/latest": b'{"tag_name": "v9.4.0"}',
        LISTING.format("debian", 11): listing("20261119T023717Z", SNAP_NEW),
        LISTING.format("debian-security", 11): listing("20261118T201500Z", "20261119T091200Z"),
    }
    table.update(over)
    return table
def epoch(stamp: str) -> float:
    return pins.snapshot_epoch(stamp)
NOW = epoch("20261120T000000Z")
root = repo(SNAP_DOCKERFILE)
code, out = run(root, snapshots(), "check", now=NOW)
check("a snapshot older than a week is behind", (code, f"{SNAP_OLD} -> 20261119T091200Z" in out), (1, True))
code, _ = run(root, snapshots(), "bump", now=NOW)
check("bump moves to the newest snapshot BOTH archives have",
      (code, f"ARG DEBIAN_SNAPSHOT=20261119T091200Z" in (root / "addon/Dockerfile").read_text()), (0, True))
root = repo(SNAP_DOCKERFILE)
code, out = run(root, snapshots(), "check", now=epoch(SNAP_OLD) + 6 * 24 * 3600)
check("a snapshot inside the week is current even though a newer one exists", code, 0)
code, out = run(root, snapshots(), "check", now=epoch(SNAP_OLD) + 8 * 24 * 3600)
check("the same snapshot a day past the week is behind", code, 1)
code, out = run(root, snapshots(**{LISTING.format("debian", 11): listing()}).copy() | {LISTING.format("debian", 10): listing()},
                "check", now=NOW)
check("an archive with no snapshot for two months fails closed (exit 2)", code, 2)
code, out = run(root, {k: v for k, v in snapshots().items() if "security" not in k}, "check", now=NOW)
check("an unreadable archive fails closed (exit 2)", code, 2)
code, _ = run(repo(SNAP_DOCKERFILE.replace(SNAP_OLD, "2026-11-01")), snapshots(), "check", now=NOW)
check("a value that is not a snapshot timestamp is refused", code, 2)
first = pins.Upstream(lambda url: snapshots()[url] if url in snapshots() else listing(), clock=lambda: epoch("20261101T120000Z"))
check("early in a month the search looks back to the month before", first.snapshot() > "20261000", True)
check("the epoch of a snapshot is the UTC time it names", pins.snapshot_epoch("20261119T000000Z"), 1795046400)

print("github asset checksums")
AH, AY = "e" * 64, "f" * 64
REL = "https://api.github.com/repos/{}/releases/tags/{}"
ASSET_DOCKERFILE = f"""FROM scratch
# upstream: github-release owner/tool
ARG TOOL_VERSION=1.0.0
# upstream: github-asset-sha256 owner/tool tool_amd64
ARG TOOL_SHA256_AMD64={"0" * 64}
# upstream: github-release other/cli
ARG CLI_VERSION=2.0.0
# upstream: github-asset-sha256 other/cli cli_amd64
ARG CLI_SHA256_AMD64={"1" * 64}
"""
def release(*assets: tuple[str, object]) -> bytes:
    return json.dumps({"assets": [{"name": n, "digest": d} for n, d in assets]}).encode()
def assets_table(**over) -> dict[str, bytes]:
    table = answers() | {
        "https://api.github.com/repos/owner/tool/releases/latest": b'{"tag_name": "v1.0.0"}',
        "https://api.github.com/repos/other/cli/releases/latest": b'{"tag_name": "2.0.0"}',
        REL.format("owner/tool", "1.0.0"): b"",
        REL.format("owner/tool", "v1.0.0"): release(("tool_amd64", f"sha256:{AH}"), ("tool_arm64", f"sha256:{AY}")),
        REL.format("other/cli", "2.0.0"): release(("cli_amd64", f"sha256:{'1' * 64}")),
    }
    return table | over
root = repo(ASSET_DOCKERFILE)
code, out = run(root, assets_table(), "check")
check("a checksum that differs from the one GitHub records is behind (also with a v-prefixed tag)",
      (code, "TOOL_SHA256_AMD64" in out, "CLI_SHA256_AMD64" in out.replace("current", "")), (1, True, True))
code, _ = run(root, assets_table(), "bump")
check("bump writes the recorded checksum, each pin against its OWN repository's release",
      (root / "addon/Dockerfile").read_text().count(AH), 1)
code, _ = run(root, assets_table(), "check")
check("after the bump everything matches", code, 0)
root = repo(ASSET_DOCKERFILE)
summary = root / "summary.json"
run(root, assets_table(), "bump", "--summary", str(summary))
moves = {c["name"]: c["republished"] for c in json.loads(summary.read_text())}
check("a checksum that changed while its version did not is flagged as re-published (silently re-pinned bytes are the attack)",
      moves, {"TOOL_SHA256_AMD64": True})
root = repo(ASSET_DOCKERFILE)
run(root, assets_table(**{"https://api.github.com/repos/owner/tool/releases/latest": b'{"tag_name": "v1.1.0"}',
                          REL.format("owner/tool", "1.1.0"): b"",
                          REL.format("owner/tool", "v1.1.0"): release(("tool_amd64", f"sha256:{AY}"))}),
    "bump", "--summary", str(summary))
check("the same change together with a new version is not",
      {c["name"]: c["republished"] for c in json.loads(summary.read_text())}, {"TOOL_VERSION": False, "TOOL_SHA256_AMD64": False})
for label, table in [
    ("a digest that is not sha256", assets_table(**{REL.format("owner/tool", "v1.0.0"): release(("tool_amd64", "md5:abc"))})),
    ("a release without a digest", assets_table(**{REL.format("owner/tool", "v1.0.0"): release(("tool_amd64", None))})),
    ("a sha256 that is not 64 hex digits", assets_table(**{REL.format("owner/tool", "v1.0.0"): release(("tool_amd64", "sha256:abc"))})),
    ("an asset missing from the release", assets_table(**{REL.format("owner/tool", "v1.0.0"): release(("other", f"sha256:{AH}"))})),
    ("a release that does not exist", {k: v for k, v in assets_table().items() if "tags/" not in k or "other/cli" in k}),
]:
    code, _ = run(repo(ASSET_DOCKERFILE), table, "check")
    check(f"{label} fails closed", code, 2)
code, _ = run(repo(ASSET_DOCKERFILE.replace("# upstream: github-release other/cli\nARG CLI_VERSION=2.0.0\n", "")), assets_table(), "check")
check("a checksum whose repository has no version pin in the file is refused", code, 2)

print("base image digest")
import hashlib
IMG = "ghcr.io/owner/img"
D_OLD = "c" * 64
IMG_DOCKERFILE = f"""ARG BUILD_FROM
# upstream: image-digest owner/base {IMG}
ARG BUILD_FROM_SHA256={D_OLD}
FROM ${{BUILD_FROM}}@sha256:${{BUILD_FROM_SHA256}} AS base
"""
IMG_BUILD = f"""build_from:
  # upstream: github-release owner/base
  amd64: {IMG}:9.5.2
  # upstream: github-release owner/base
  aarch64: {IMG}:9.5.2
"""
INDEX = "https://ghcr.io/v2/owner/img/manifests/{}"
def index(tag: str) -> bytes:
    return json.dumps({"manifests": [{"digest": "sha256:" + "1" * 64, "platform": {"os": "linux", "architecture": "amd64"}}], "tag": tag}).encode()
def digest_of(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()
def image_table(**over) -> dict[str, bytes]:
    table = answers() | {"https://api.github.com/repos/owner/base/releases/latest": b'{"tag_name": "v9.5.2"}',
                         INDEX.format("9.5.2"): index("9.5.2")}
    return table | over
code, out = run(repo(IMG_DOCKERFILE, IMG_BUILD), image_table(), "check")
check("a digest that is not the sha256 of the tag's index is behind",
      (code, f"{D_OLD} -> {digest_of(index('9.5.2'))}" in out), (1, True))
root = repo(IMG_DOCKERFILE, IMG_BUILD)
run(root, image_table(), "bump")
check("bump writes the digest of the index document",
      f"ARG BUILD_FROM_SHA256={digest_of(index('9.5.2'))}\n" in (root / "addon/Dockerfile").read_text(), True)
code, _ = run(root, image_table(), "check")
check("after the bump everything matches", code, 0)
newer = image_table(**{"https://api.github.com/repos/owner/base/releases/latest": b'{"tag_name": "v9.6.0"}',
                       INDEX.format("9.6.0"): index("9.6.0")})
root = repo(IMG_DOCKERFILE, IMG_BUILD)
run(root, newer, "bump")
check("a newer release moves the tag in build.yaml AND the digest of THAT tag together",
      (f"amd64: {IMG}:9.6.0" in (root / "addon/build.yaml").read_text(),
       f"BUILD_FROM_SHA256={digest_of(index('9.6.0'))}" in (root / "addon/Dockerfile").read_text()), (True, True))
for label, table in [
    ("an answer that is not an index", image_table(**{INDEX.format("9.5.2"): b'{"layers": []}'})),
    ("an index with no manifests", image_table(**{INDEX.format("9.5.2"): b'{"manifests": []}'})),
    ("a registry that could not be read", {k: v for k, v in image_table().items() if "ghcr" not in k}),
]:
    code, _ = run(repo(IMG_DOCKERFILE, IMG_BUILD), table, "check")
    check(f"{label} fails closed", code, 2)
code, _ = run(repo(IMG_DOCKERFILE.replace("ghcr.io/owner/img", "docker.io/owner/img"), IMG_BUILD.replace("ghcr.io", "docker.io")), image_table(), "check")
check("a registry other than ghcr.io is refused", code, 2)
code, _ = run(repo(IMG_DOCKERFILE, IMG_BUILD.replace("aarch64: ghcr.io/owner/img:9.5.2", "aarch64: ghcr.io/owner/img:9.5.3")),
              image_table(**{INDEX.format("9.5.3"): index("9.5.3")}), "check")
check("architectures that name different tags for the image are refused", code, 2)
code, _ = run(repo(IMG_DOCKERFILE, "build_from:\n"), image_table(), "check")
check("a digest with no release pin for its image is refused", code, 2)
code, _ = run(repo(IMG_DOCKERFILE.replace(D_OLD, "short"), IMG_BUILD), image_table(), "check")
check("a digest that is not 64 hex digits is refused", code, 2)
code, _ = run(repo(IMG_DOCKERFILE.replace(f"# upstream: image-digest owner/base {IMG}\n", ""), IMG_BUILD), image_table(), "check")
check("a digest line without its marker is refused", code, 2)

print("pip requirements and lock")
def lock_text(**versions: str) -> str:
    v = {"Foo": "1.0.0", "bar": "2.0.0", "baz": "0.1.0"} | versions
    return (f"foo=={v['Foo']} \\\n    --hash=sha256:{'a' * 64}\n"
            f"bar=={v['bar']} ; sys_platform == 'linux' \\\n    --hash=sha256:{'b' * 64} \\\n    --hash=sha256:{'c' * 64}\n"
            f"    # via foo\n"
            f"baz=={v['baz']} \\\n    --hash=sha256:{'d' * 64}\n")
REQ = "# header\nFoo==1.0.0\nbar==2.0.0\n"
PIP_FILES = {"addon/py-tools/requirements.in": REQ, "addon/py-tools/requirements.lock": lock_text()}
PIP_TABLE = answers() | {"https://pypi.org/pypi/Foo/json": b'{"info": {"version": "1.0.0"}}',
                         "https://pypi.org/pypi/bar/json": b'{"info": {"version": "2.0.0"}}'}
code, out = run(repo(files=PIP_FILES), PIP_TABLE, "check")
check("requirements are pins, the lock agrees (names normalised) -> current", code, 0)
code, out = run(repo(files=PIP_FILES), PIP_TABLE | {"https://pypi.org/pypi/bar/json": b'{"info": {"version": "2.1.0"}}'}, "check")
check("a newer release is reported", (code, "2.0.0 -> 2.1.0" in out), (1, True))
relocked.clear()
root = repo(files=PIP_FILES)
run(root, PIP_TABLE | {"https://pypi.org/pypi/bar/json": b'{"info": {"version": "2.1.0"}}'}, "bump")
check("bump rewrites the requirement and regenerates the lock beside it",
      ("bar==2.1.0" in (root / "addon/py-tools/requirements.in").read_text(), relocked), (True, [pathlib.Path("addon/py-tools")]))
for label, files in [
    ("a requirement without a hash", {"addon/py-tools/requirements.lock": lock_text().replace(f" \\\n    --hash=sha256:{'d' * 64}", "")}),
    ("a lock that holds another version than the manifest", {"addon/py-tools/requirements.lock": lock_text(Foo="1.0.1")}),
    ("a lock that lacks a pinned package", {"addon/py-tools/requirements.lock": lock_text().replace("foo==", "foo2==")}),
    ("a range in the manifest", {"addon/py-tools/requirements.in": REQ.replace("bar==2.0.0", "bar>=2.0.0")}),
    ("a hash that is not sha256", {"addon/py-tools/requirements.lock": lock_text().replace("a" * 64, "a" * 10)}),
]:
    code, _ = run(repo(files=PIP_FILES | files), PIP_TABLE, "check")
    check(f"{label} is refused", code, 2)
code, _ = run(repo(files={"addon/py-tools/requirements.in": REQ}), PIP_TABLE, "check")
check("a requirements.in without a lock is not a pin file (nothing is pinned by it)", code, 0)

print("this repository")
found = pins.discover(REPO)
check("every pin in the add-on declares an upstream (no unmarked pin)", len(found) > 0, True)
check("the bundled command-line tools are pinned by their package.json",
      sorted(p.args[0] for p in found if p.file.name == "package.json"), ["@playwright/mcp", "ccstatusline"])
check("the Claude checksums have their version pin beside them",
      sum(1 for p in found if p.kind == "claude-code-sha256"), 2)
check("the Node checksums have their version pin beside them",
      sum(1 for p in found if p.kind == "nodejs-sha256"), 2)
check("the Debian snapshot the image installs from is a pin",
      [p.kind for p in found if p.name == "DEBIAN_SNAPSHOT"], ["debian-snapshot"])
check("the base image is pinned by digest",
      [p.name for p in found if p.kind == "image-digest"], ["BUILD_FROM_SHA256"])
check("ha and yq downloads have a checksum each per architecture",
      sorted(p.args[1] for p in found if p.kind == "github-asset-sha256"),
      ["ha_aarch64", "ha_amd64", "yq_linux_amd64", "yq_linux_arm64"])
check("the image's Python packages are pinned by requirements.in",
      sorted(p.args[0] for p in found if p.file.parent.name == "py-tools" and p.file.name == "requirements.in"),
      ["Pillow", "hass-mcp", "homeassistant-cli"])
check("the tools the workflows install are pinned and hash-locked the same way",
      [p.args[0] for p in found if p.file.parent.name == "ci-tools" and p.file.name == "requirements.in"], ["uv", "pyyaml"])
check("the pinned ha-agent-core release is watched",
      [p.args[0] for p in found if p.kind == "core-lock"], ["LayerTM/ha-agent-core"])

if fails:
    print(f"{fails} failure(s)")
    sys.exit(1)
print("all passed")
