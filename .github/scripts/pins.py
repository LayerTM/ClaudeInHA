#!/usr/bin/env python3
"""Upstream pins: where each one comes from is declared once, beside the pin.

A pinned line is preceded by a marker comment naming its upstream:

    # upstream: npm ccstatusline
    ARG CCSTATUSLINE_VERSION=2.2.29

The value is whatever follows the last `=` or `:` on the pinned line, so the
same marker works for a Dockerfile ARG and for an image tag in build.yaml.
The files are discovered, not listed: every tracked file carrying a marker
takes part.

A tracked package.json with a package-lock.json beside it needs no markers:
each of its `dependencies` is an `npm <package>` pin and must be an exact
version. Bumping one also refreshes that lockfile (npm, scripts off), so the
lockfile — and the install-script check that reads it — follow the version.

Kinds:
  pypi <package>                    latest release on PyPI
  npm <package>                     the `latest` dist-tag on npm
  github-release <owner/repo>       the latest (non-prerelease) GitHub release
  nodejs lts-ready                  newest Node.js release on the newest major
                                    line that is either the one pinned now or
                                    has had an LTS release (a new odd/current
                                    major is not taken before it is LTS-ready)
  claude-code <BASE_ARG> <channel>  <base>/<channel>, where <base> is the value
                                    of the ARG named BASE_ARG in the same file
  claude-code-sha256 <platform>     .platforms[<platform>].checksum from
                                    <base>/<version>/manifest.json of the
                                    claude-code pin in the same file
  nodejs-sha256 <platform>          the SHASUMS256.txt entry for
                                    node-v<version>-<platform>.tar.xz of the
                                    nodejs pin in the same file

A checksum pin follows the version pin it belongs to (the one pin of its owner
kind in the same file): a bump moves both together, and `check` reports a
checksum that no longer matches the pinned version.

Commands:
  check          print every pin against its upstream; exit 1 if any is behind
  bump [--summary FILE]
                 rewrite every stale pin (checksums with their version) and
                 write a JSON summary of what moved

Every failure to read an upstream or to parse a pin exits 2: an upstream that
could not be asked is never reported as up to date.
"""

from __future__ import annotations

import json
import shutil
import os
import pathlib
import re
import subprocess
import sys
import urllib.request

MARKER = re.compile(r"^\s*#\s*upstream:\s*(\S+)((?:\s+\S+)*)\s*$")
PINNED = re.compile(r"^(?P<head>.*[=:])(?P<value>[^=:\s]+)(?P<tail>\s*)$")
VERSION = re.compile(r"^\d+(?:\.\d+)*$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
# checksum kind -> the version kind it belongs to
CHECKSUM_OWNER = {"claude-code-sha256": "claude-code", "nodejs-sha256": "nodejs"}


class PinError(Exception):
    """A pin that cannot be read, or an upstream that cannot be asked."""


def version_key(value: str) -> tuple[int, ...]:
    return tuple(int(part) for part in value.split("."))


def clean_version(raw: str, source: str) -> str:
    value = raw.strip()
    if value.startswith("v"):
        value = value[1:]
    if not VERSION.match(value):
        raise PinError(f"{source} answered {raw!r}, which is not a release version")
    return value


def http_get(url: str) -> bytes:
    headers = {"User-Agent": "addon-pins"}
    token = os.environ.get("GITHUB_TOKEN")
    if token and url.startswith("https://api.github.com/"):
        headers["Authorization"] = f"Bearer {token}"
    last = None
    for _ in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as resp:
                return resp.read()
        except Exception as err:  # noqa: BLE001 — every failure is reported, none is swallowed
            last = err
    raise PinError(f"could not read {url}: {last}")


class Upstream:
    """Answers "what is the newest value" for one marker. Cached per URL."""

    def __init__(self, fetch=http_get):
        self.fetch = fetch
        self.cache: dict[str, bytes] = {}

    def get(self, url: str) -> bytes:
        if url not in self.cache:
            self.cache[url] = self.fetch(url)
        return self.cache[url]

    def json(self, url: str):
        try:
            return json.loads(self.get(url))
        except ValueError as err:
            raise PinError(f"{url} did not return JSON: {err}") from err

    def field(self, url: str, *path):
        """One value inside a JSON answer. An answer of any other shape is unreadable."""
        value = self.json(url)
        for step in path:
            try:
                value = value[step]
            except (KeyError, IndexError, TypeError) as err:
                raise PinError(f"{url} has no {'.'.join(map(str, path))}") from err
        return value

    def text(self, url: str, *path) -> str:
        """A string inside a JSON answer. A number or anything else is not a version or a checksum."""
        value = self.field(url, *path)
        if not isinstance(value, str):
            raise PinError(f"{url} gave {value!r} for {'.'.join(map(str, path))}, which is not text")
        return value

    def latest(self, pin: "Pin", pins: list["Pin"]) -> str:
        kind, args = pin.kind, pin.args
        if kind == "pypi" and len(args) == 1:
            url = f"https://pypi.org/pypi/{args[0]}/json"
            return clean_version(self.text(url, "info", "version"), url)
        if kind == "npm" and len(args) == 1:
            url = f"https://registry.npmjs.org/{args[0]}/latest"
            return clean_version(self.text(url, "version"), url)
        if kind == "github-release" and len(args) == 1:
            url = f"https://api.github.com/repos/{args[0]}/releases/latest"
            return clean_version(self.text(url, "tag_name"), url)
        if kind == "nodejs" and args == ["lts-ready"]:
            return self.nodejs(pin)
        if kind == "claude-code" and len(args) == 2:
            base = arg_value(pin.file, args[0], pins)
            url = f"{base.rstrip('/')}/{args[1]}"
            return clean_version(self.get(url).decode("utf-8", "replace"), url)
        if pin.is_checksum() and len(args) == 1:
            owner = owner_pin(pin, pins)
            version = owner.target if owner.target else owner.value
            if kind == "claude-code-sha256":
                base = arg_value(pin.file, owner.args[0], pins)
                url = f"{base.rstrip('/')}/{version}/manifest.json"
                checksum = self.text(url, "platforms", args[0], "checksum")
            else:
                url = f"https://nodejs.org/dist/v{version}/SHASUMS256.txt"
                checksum = self.shasums_entry(url, f"node-v{version}-{args[0]}.tar.xz")
            if not SHA256.match(checksum):
                raise PinError(f"{url} gave {checksum!r} for {args[0]}, not a SHA-256")
            return checksum
        raise PinError(f"{pin.where}: unknown upstream '{kind} {' '.join(args)}'")

    def shasums_entry(self, url: str, filename: str) -> str:
        """The checksum on the one `<sha256>  <filename>` line of a SHASUMS file."""
        found = [
            parts[0] for parts in (line.split() for line in self.get(url).decode("utf-8", "replace").splitlines())
            if len(parts) == 2 and parts[1] == filename
        ]
        if len(found) != 1:
            raise PinError(f"{url} lists {filename} {len(found)} times, expected exactly once")
        return found[0]

    def nodejs(self, pin: "Pin") -> str:
        url = "https://nodejs.org/dist/index.json"
        releases = self.json(url)
        if not isinstance(releases, list) or not releases:
            raise PinError(f"{url} returned no releases")
        by_major: dict[int, list[str]] = {}
        lts_majors: set[int] = set()
        for rel in releases:
            if not isinstance(rel, dict):
                raise PinError(f"{url} lists a release that is not an object: {rel!r}")
            if not isinstance(rel.get("version"), str):
                raise PinError(f"{url} lists a release whose version is not text: {rel!r}")
            version = clean_version(rel["version"], url)
            major = version_key(version)[0]
            by_major.setdefault(major, []).append(version)
            if rel.get("lts"):
                lts_majors.add(major)
        current_major = version_key(pin.value)[0]
        eligible = [m for m in by_major if m == current_major or m in lts_majors]
        if not eligible:
            raise PinError(f"{url} has no release on the Node.js {current_major} line or any LTS line")
        return max(by_major[max(eligible)], key=version_key)


class Pin:
    def __init__(self, file: pathlib.Path, line_no: int, kind: str, args: list[str], head: str, value: str, tail: str):
        self.file, self.line_no, self.kind, self.args = file, line_no, kind, args
        self.head, self.value, self.tail = head, value, tail
        self.target: str | None = None

    @property
    def where(self) -> str:
        return f"{self.file}:{self.line_no}"

    @property
    def name(self) -> str:
        # `ARG NAME=` -> NAME; `amd64: image:` -> amd64
        tokens = self.head.split()
        if tokens[:1] == ["ARG"]:
            tokens = tokens[1:]
        return tokens[0].split("=")[0].rstrip(":").strip('"') if tokens else self.where

    def is_checksum(self) -> bool:
        return self.kind in CHECKSUM_OWNER


def arg_value(file: pathlib.Path, name: str, pins: list[Pin]) -> str:
    """The value of `ARG <name>=...` in a file (it need not be a pin itself)."""
    found = re.findall(rf"^ARG\s+{re.escape(name)}=(\S+)\s*$", file.read_text(), flags=re.M)
    if len(found) != 1:
        raise PinError(f"{file}: expected exactly one ARG {name}, found {len(found)}")
    return found[0]


def owner_pin(pin: Pin, pins: list[Pin]) -> Pin:
    """The version pin a checksum pin belongs to: the one pin of its owner kind in the same file."""
    kind = CHECKSUM_OWNER[pin.kind]
    owners = [p for p in pins if p.file == pin.file and p.kind == kind]
    if len(owners) != 1:
        raise PinError(f"{pin.where}: a {pin.kind} pin needs exactly one {kind} pin in its file, found {len(owners)}")
    return owners[0]


def git(root: pathlib.Path, *args: str) -> bytes:
    run = subprocess.run(["git", "-C", str(root), *args], capture_output=True, check=False)
    if run.returncode != 0:
        raise PinError(f"git {' '.join(args)}: {run.stderr.decode().strip()}")
    return run.stdout


def tracked_texts(root: pathlib.Path):
    """(path, text) of every tracked text file in the work tree."""
    for name in git(root, "ls-files", "-z").decode().split("\0"):
        file = root / name
        if not name or file.suffix in {".py", ".md"} or not file.is_file():
            continue
        try:
            yield file, file.read_text()
        except UnicodeDecodeError:
            continue


# Lines that ARE upstream pins by their shape. One of these without a marker
# above it is an error, so a pin added later cannot silently stay unwatched.
UNDECLARED = {
    "Dockerfile": re.compile(r"^ARG\s+\w*(?:_VERSION|_SHA256\w*)=\S"),
    "build.yaml": re.compile(r"^\s+[\w-]+:\s*\S+:\d+(?:\.\d+)+\s*$"),
}


DEPENDENCY = re.compile(r'^(?P<head>\s*"(?P<name>[^"]+)":\s*")(?P<value>[^"]*)(?P<tail>",?\s*)$')


def npm_manifest_pins(file: pathlib.Path, root: pathlib.Path, text: str) -> list[Pin]:
    """The `dependencies` of a package.json that has a lockfile, one pin each."""
    rel = file.relative_to(root)
    try:
        wanted = json.loads(text).get("dependencies", {})
    except (ValueError, AttributeError) as err:
        raise PinError(f"{rel}: not a JSON object with dependencies: {err}") from err
    found: list[Pin] = []
    inside = False
    for i, line in enumerate(text.splitlines()):
        if re.match(r'^\s*"dependencies":\s*\{\s*$', line):
            inside = True
            continue
        if inside and re.match(r"^\s*\},?\s*$", line):
            break
        dep = DEPENDENCY.match(line) if inside else None
        if dep:
            if not VERSION.match(dep["value"]):
                raise PinError(f"{rel}:{i + 1}: {dep['name']} is {dep['value']!r}, not an exact version")
            found.append(Pin(file, i + 1, "npm", [dep["name"]], dep["head"], dep["value"], dep["tail"]))
    if sorted(p.args[0] for p in found) != sorted(wanted):
        raise PinError(f"{rel}: dependencies must be an object with one \"name\": \"version\" per line")
    return found


def discover(root: pathlib.Path) -> list[Pin]:
    pins: list[Pin] = []
    for file, text in tracked_texts(root):
        lines = text.splitlines()
        rel = file.relative_to(root)
        if file.name == "package.json" and (file.parent / "package-lock.json").is_file():
            pins.extend(npm_manifest_pins(file, root, text))
            continue
        shape = UNDECLARED.get(file.name)
        for i, line in enumerate(lines):
            if shape and shape.match(line) and not (i and MARKER.match(lines[i - 1])):
                raise PinError(f"{rel}:{i + 1}: pinned without an upstream marker above it")
            marker = MARKER.match(line)
            if not marker:
                continue
            if i + 1 >= len(lines):
                raise PinError(f"{rel}:{i + 1}: upstream marker with no pinned line after it")
            pinned = PINNED.match(lines[i + 1])
            if not pinned or lines[i + 1].lstrip().startswith("#"):
                raise PinError(f"{rel}:{i + 2}: the line after an upstream marker carries no value")
            pin = Pin(file, i + 2, marker.group(1), marker.group(2).split(), pinned["head"], pinned["value"], pinned["tail"])
            value_shape = SHA256 if pin.is_checksum() else VERSION
            if not value_shape.match(pin.value):
                raise PinError(f"{rel}:{i + 2}: {pin.value!r} is not a {'SHA-256' if pin.is_checksum() else 'version'}")
            pins.append(pin)
    if not pins:
        raise PinError("no upstream markers found — nothing was checked")
    return pins


def resolve(pins: list[Pin], upstream: Upstream) -> None:
    """Set each pin's target. Versions first: a checksum follows its version."""
    for pin in sorted(pins, key=Pin.is_checksum):
        latest = upstream.latest(pin, pins)
        if pin.is_checksum():
            pin.target = latest
        else:
            pin.target = latest if version_key(latest) > version_key(pin.value) else pin.value


def stale(pins: list[Pin]) -> list[Pin]:
    return [p for p in pins if p.target != p.value]


def label(pin: Pin, root: pathlib.Path) -> str:
    return f"{pin.name} ({pin.file.relative_to(root)}:{pin.line_no}, {pin.kind} {' '.join(pin.args)})"


def cmd_check(root: pathlib.Path, upstream: Upstream) -> int:
    pins = discover(root)
    resolve(pins, upstream)
    for pin in pins:
        state = "behind" if pin.target != pin.value else "current"
        print(f"{state:8} {label(pin, root)}: {pin.value}" + (f" -> {pin.target}" if pin.target != pin.value else ""))
    behind = stale(pins)
    if behind:
        print(f"{len(behind)} pin(s) behind upstream; run: python3 .github/scripts/pins.py bump")
        return 1
    print(f"all {len(pins)} pins match their upstream")
    return 0


def refresh_lockfile(directory: pathlib.Path, root: pathlib.Path) -> None:
    npm = shutil.which("npm")
    if not npm:
        raise PinError(f"{directory.relative_to(root)}: npm is needed to refresh package-lock.json")
    run = subprocess.run(
        [npm, "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
        cwd=directory, capture_output=True, text=True, check=False,
    )
    if run.returncode != 0:
        raise PinError(f"{directory.relative_to(root)}: npm could not refresh package-lock.json: {run.stderr.strip()}")
    print(f"locked   {(directory / 'package-lock.json').relative_to(root)}")


def cmd_bump(root: pathlib.Path, upstream: Upstream, summary: pathlib.Path | None,
             relock=refresh_lockfile) -> int:
    pins = discover(root)
    resolve(pins, upstream)
    changes = []
    for pin in stale(pins):
        lines = pin.file.read_text().splitlines(keepends=True)
        line = lines[pin.line_no - 1]
        ending = line[len(line.rstrip("\r\n")):]
        lines[pin.line_no - 1] = f"{pin.head}{pin.target}{pin.tail}{ending}"
        pin.file.write_text("".join(lines))
        major = (not pin.is_checksum()) and version_key(pin.target)[0] != version_key(pin.value)[0]
        changes.append({
            "name": pin.name, "file": str(pin.file.relative_to(root)), "kind": pin.kind,
            "source": " ".join(pin.args), "from": pin.value, "to": pin.target, "major": major,
        })
        print(f"bumped   {label(pin, root)}: {pin.value} -> {pin.target}")
    for directory in sorted({p.file.parent for p in stale(pins) if p.file.name == "package.json"}):
        relock(directory, root)
    if not changes:
        print(f"all {len(pins)} pins match their upstream")
    if summary:
        summary.write_text(json.dumps(changes, indent=2) + "\n")
    return 0


def main(argv: list[str], upstream: Upstream | None = None, root: pathlib.Path | None = None,
         relock=refresh_lockfile) -> int:
    root = root or pathlib.Path(__file__).resolve().parents[2]
    upstream = upstream or Upstream()
    try:
        if argv[:1] == ["check"] and len(argv) == 1:
            return cmd_check(root, upstream)
        if argv[:1] == ["bump"]:
            summary = None
            if len(argv) == 3 and argv[1] == "--summary":
                summary = pathlib.Path(argv[2])
            elif len(argv) != 1:
                raise PinError("usage: pins.py bump [--summary FILE]")
            return cmd_bump(root, upstream, summary, relock)
        raise PinError("usage: pins.py check | bump [--summary FILE]")
    except PinError as err:
        print(f"error: {err}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
