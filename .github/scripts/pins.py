#!/usr/bin/env python3
"""Upstream pins: where each one comes from is declared once, beside the pin.

A pinned line is preceded by a marker comment naming its upstream:

    # upstream: npm ccstatusline
    ARG CCSTATUSLINE_VERSION=2.2.29

The value is whatever follows the last `=` or `:` on the pinned line, so the
same marker works for a Dockerfile ARG and for an image tag in build.yaml.
The files are discovered, not listed: every tracked file carrying a marker
takes part.

A tracked `core.lock.json` (the pinned ha-agent-core release) needs no marker
either: it is a `core-lock` pin on the GitHub repository its own `url` names,
compared with that repository's latest release. Bumping it replaces the file
with the `core.lock.json` asset of that release.

A tracked requirements.in with a requirements.lock beside it needs no markers
either: each line is a `pypi <package>` pin and must be `name==version`. The
lock is every distribution, transitive ones included, with every hash
(`pip install --require-hashes`); a bump regenerates it with uv, and a lock
that does not hold each pin at its version, or holds a requirement without a
hash, is refused.

A tracked package.json with a package-lock.json beside it needs no markers:
each of its `dependencies` is an `npm <package>` pin and must be an exact
version. Bumping one also refreshes that lockfile (npm, scripts off), so the
lockfile — and the install-script check that reads it — follow the version.

Kinds:
  pypi <package>                    latest release on PyPI
  npm <package>                     the `latest` dist-tag on npm
  github-release <owner/repo>       the latest (non-prerelease) GitHub release
  core-lock <owner/repo>            the latest GitHub release of the repository the
                                    lock's url points at (found, not declared)
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
  github-asset-sha256 <repo> <asset>
                                    the sha256 GitHub records for <asset> of
                                    the release of the github-release pin on
                                    <repo> in the same file (a download checked
                                    against it at build time)
  image-digest <repo> <image>       the digest of a base image's multi-architecture
                                    index (sha256 of the index itself): the tag is
                                    the one every github-release pin on <repo>
                                    names for <image>, in any file. The digest is
                                    its own pin because build.yaml's build_from
                                    accepts a tag only; the Dockerfile appends it
  debian-snapshot                   the newest snapshot.debian.org timestamp
                                    that both the debian and the debian-security
                                    archives have (apt reads every package
                                    version from the pinned snapshot, so the
                                    same tree installs the same packages on any
                                    day). Unlike the other pins it is behind
                                    only when it is older than SNAPSHOT_MAX_AGE:
                                    packages move in one weekly wave, not on
                                    every upload

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

import calendar
import hashlib
import http.client
import json
import shutil
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

MARKER = re.compile(r"^\s*#\s*upstream:\s*(\S+)((?:\s+\S+)*)\s*$")
PINNED = re.compile(r"^(?P<head>.*[=:])(?P<value>[^=:\s]+)(?P<tail>\s*)$")
VERSION = re.compile(r"^\d+(?:\.\d+)*$")
# a semver pre-release (v27.0.0-alpha.0.0.0): published in the Node.js index, never a pin target
PRERELEASE = re.compile(r"^v?\d+\.\d+\.\d+-\S+$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
# a snapshot.debian.org timestamp (UTC): 20261119T024521Z
SNAPSHOT = re.compile(r"^\d{8}T\d{6}Z$")
SNAPSHOT_LINK = re.compile(r'href="(\d{8}T\d{6}Z)/"')
SNAPSHOT_ARCHIVES = ("debian", "debian-security")
SNAPSHOT_MAX_AGE = 7 * 24 * 3600
# seconds to wait before each further attempt at a fetch that failed for a passing reason
RETRY_WAITS = (2, 5, 15)
# the longest wait an upstream's Retry-After is granted
RETRY_AFTER_CAP = 60
# checksum kind -> the version kind it belongs to
CHECKSUM_OWNER = {"claude-code-sha256": "claude-code", "nodejs-sha256": "nodejs",
                  "github-asset-sha256": "github-release"}


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


def snapshot_epoch(value: str) -> int:
    """Seconds since the epoch of a snapshot timestamp."""
    if not SNAPSHOT.match(value):
        raise PinError(f"{value!r} is not a snapshot timestamp (YYYYMMDDTHHMMSSZ)")
    return calendar.timegm(time.strptime(value, "%Y%m%dT%H%M%SZ"))


def transient(err: Exception) -> bool:
    """Whether the same request may succeed later: throttled, a server fault, or the network."""
    if isinstance(err, urllib.error.HTTPError):
        return err.code == 429 or 500 <= err.code < 600
    return isinstance(err, (OSError, http.client.HTTPException))


def retry_wait(err: Exception, backoff: int) -> int:
    """The upstream's Retry-After in seconds, capped; the backoff when it names none."""
    if isinstance(err, urllib.error.HTTPError):
        asked = (err.headers.get("Retry-After") or "").strip()
        if re.fullmatch(r"[0-9]+", asked):
            return min(int(asked), RETRY_AFTER_CAP)
    return backoff


def http_get(url: str, sleep=time.sleep) -> bytes:
    headers = {"User-Agent": "addon-pins"}
    token = os.environ.get("GITHUB_TOKEN")
    if token and url.startswith("https://api.github.com/"):
        headers["Authorization"] = f"Bearer {token}"
    if url.startswith("https://ghcr.io/v2/"):
        repo = url.split("/manifests/")[0].removeprefix("https://ghcr.io/v2/")
        token_url = f"https://ghcr.io/token?scope=repository:{repo}:pull"
        anonymous = json.loads(http_get(token_url, sleep))["token"]
        headers["Authorization"] = "Bearer " + anonymous
        headers["Accept"] = ("application/vnd.oci.image.index.v1+json, "
                             "application/vnd.docker.distribution.manifest.list.v2+json")
    waits = iter(RETRY_WAITS)
    while True:
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as resp:
                return resp.read()
        except Exception as err:  # noqa: BLE001 — every failure is reported, none is swallowed
            backoff = next(waits, None)
            if backoff is None or not transient(err):
                raise PinError(f"could not read {url}: {err}") from err
            sleep(retry_wait(err, backoff))


class Upstream:
    """Answers "what is the newest value" for one marker. Cached per URL."""

    def __init__(self, fetch=http_get, clock=time.time):
        self.fetch = fetch
        self.clock = clock
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
        if kind in ("github-release", "core-lock") and len(args) == 1:
            url = f"https://api.github.com/repos/{args[0]}/releases/latest"
            return clean_version(self.text(url, "tag_name"), url)
        if kind == "nodejs" and args == ["lts-ready"]:
            return self.nodejs(pin)
        if kind == "debian-snapshot" and not args:
            return self.snapshot()
        if kind == "claude-code" and len(args) == 2:
            base = arg_value(pin.file, args[0], pins)
            url = f"{base.rstrip('/')}/{args[1]}"
            return clean_version(self.get(url).decode("utf-8", "replace"), url)
        if kind == "github-asset-sha256" and len(args) == 2:
            owner = owner_pin(pin, pins)
            return self.asset_sha256(args[0], owner.target or owner.value, args[1])
        if kind == "image-digest" and len(args) == 2:
            return self.image_digest(pin, pins)
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

    def asset_sha256(self, repo: str, version: str, asset: str) -> str:
        """The sha256 GitHub records for one asset of the release of `version`."""
        last: PinError | None = None
        for tag in (version, f"v{version}"):
            url = f"https://api.github.com/repos/{repo}/releases/tags/{tag}"
            try:
                assets = self.field(url, "assets")
            except PinError as err:
                last = err
                continue
            if not isinstance(assets, list):
                raise PinError(f"{url} has no list of assets")
            found = [a.get("digest") for a in assets if isinstance(a, dict) and a.get("name") == asset]
            if len(found) != 1:
                raise PinError(f"{url} lists {asset} {len(found)} times, expected exactly once")
            digest = found[0]
            if not isinstance(digest, str) or not digest.startswith("sha256:") or not SHA256.match(digest[7:]):
                raise PinError(f"{url} records {digest!r} for {asset}, not a sha256")
            return digest[7:]
        raise PinError(f"no release of {repo} is tagged {version} or v{version}: {last}")

    def image_digest(self, pin: "Pin", pins: list["Pin"]) -> str:
        """The digest of the image index the tag names: the sha256 of the index document itself."""
        repo, image = pin.args
        registry, _, name = image.partition("/")
        if registry != "ghcr.io" or not name:
            raise PinError(f"{pin.where}: only ghcr.io images are supported, found {image!r}")
        tags = {p.target or p.value for p in pins
                if p.kind == "github-release" and p.args == [repo] and image in p.head}
        if len(tags) != 1:
            raise PinError(f"{pin.where}: expected the github-release pins of {repo} for {image} to name one tag, found {sorted(tags)}")
        index_url = f"https://ghcr.io/v2/{name}/manifests/{tags.pop()}"
        body = self.get(index_url)
        index = self.json(index_url)
        if not isinstance(index, dict) or not isinstance(index.get("manifests"), list) or not index["manifests"]:
            raise PinError(f"{index_url} is not an image index")
        return hashlib.sha256(body).hexdigest()

    def snapshot(self) -> str:
        """The newest timestamp that every archive apt reads has a snapshot for."""
        now = time.gmtime(self.clock())
        newest = []
        for archive in SNAPSHOT_ARCHIVES:
            found: list[str] = []
            # the month's first hours may have no snapshot yet: look one month back
            for year, month in ((now.tm_year, now.tm_mon), (now.tm_year - (now.tm_mon == 1), now.tm_mon - 1 or 12)):
                url = f"https://snapshot.debian.org/archive/{archive}/?year={year}&month={month}"
                found = SNAPSHOT_LINK.findall(self.get(url).decode("utf-8", "replace"))
                if found:
                    break
            if not found:
                raise PinError(f"snapshot.debian.org lists no {archive} snapshot for the last two months")
            newest.append(max(found))
        return min(newest)

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
            if PRERELEASE.match(rel["version"].strip()):
                continue
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
        if self.kind == "core-lock":
            return self.args[0].split("/")[-1]
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
    owners = [p for p in pins if p.file == pin.file and p.kind == kind
              and (pin.kind != "github-asset-sha256" or p.args == [pin.args[0]])]
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


REQUIREMENT = re.compile(r"^(?P<head>(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)==)(?P<value>\d+(?:\.\d+)*)(?P<tail>\s*)$")
LOCK_ENTRY = re.compile(r"^(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)==(?P<version>[^\s;]+)")


def normalized(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def lock_blocks(text: str):
    """(line number, name, version, text) of each requirement with its continuation lines."""
    block: list[str] = []
    head = None
    for number, line in enumerate(text.splitlines(), 1):
        entry = LOCK_ENTRY.match(line)
        if entry:
            if head:
                yield (*head, "\n".join(block))
            head, block = (number, entry["name"], entry["version"]), [line]
        elif head and line.startswith((" ", "\t")):
            block.append(line)
    if head:
        yield (*head, "\n".join(block))


def pip_manifest_pins(file: pathlib.Path, root: pathlib.Path, text: str) -> list[Pin]:
    """The requirements of a requirements.in that has a requirements.lock, one pin each.

    The lock must hold every pin at its version, and every requirement in it
    must carry a hash: `pip install --require-hashes` refuses the rest, and a
    lock that says something else than its manifest would install other versions.
    """
    rel = file.relative_to(root)
    found: list[Pin] = []
    for i, line in enumerate(text.splitlines()):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        req = REQUIREMENT.match(line)
        if not req:
            raise PinError(f"{rel}:{i + 1}: {line.strip()!r} is not an exact `name==version` requirement")
        found.append(Pin(file, i + 1, "pypi", [req["name"]], req["head"], req["value"], req["tail"]))
    if not found:
        raise PinError(f"{rel}: no requirements")
    lock = file.with_name("requirements.lock")
    held: dict[str, str] = {}
    for number, name, version, block in lock_blocks(lock.read_text()):
        if not re.search(r"--hash=sha256:[0-9a-f]{64}", block):
            raise PinError(f"{lock.relative_to(root)}:{number}: {name} has no hash")
        held[normalized(name)] = version
    for pin in found:
        have = held.get(normalized(pin.args[0]))
        if have != pin.value:
            raise PinError(f"{lock.relative_to(root)} holds {pin.args[0]} at {have!r}, {rel} pins {pin.value}")
    return found


CORE_LOCK_URL = re.compile(r"^https://github\.com/(?P<repo>[^/]+/[^/]+)/releases/download/v(?P<version>[^/]+)/")


def core_lock_pin(file: pathlib.Path, root: pathlib.Path, text: str) -> Pin:
    """The one pin of a core.lock.json: its version, on the repository its url names."""
    rel = file.relative_to(root)
    try:
        lock = json.loads(text)
        version, url = lock["version"], lock["url"]
    except (ValueError, KeyError, TypeError) as err:
        raise PinError(f"{rel}: not a lock with a version and a url: {err}") from err
    named = CORE_LOCK_URL.match(url) if isinstance(url, str) else None
    if not named or named["version"] != version or not isinstance(version, str) or not VERSION.match(version):
        raise PinError(f"{rel}: url {url!r} is not the GitHub release download of version {version!r}")
    line_no = next((i + 1 for i, line in enumerate(text.splitlines()) if re.match(r'^\s*"version":', line)), 1)
    return Pin(file, line_no, "core-lock", [named["repo"]], "", version, "")


def core_lock_asset(pin: Pin, upstream: Upstream) -> str:
    """The core.lock.json published with the release the pin is bumped to."""
    url = f"https://github.com/{pin.args[0]}/releases/download/v{pin.target}/core.lock.json"
    text = upstream.get(url).decode("utf-8", "replace")
    try:
        got = json.loads(text).get("version")
    except (ValueError, AttributeError) as err:
        raise PinError(f"{url} is not a lock: {err}") from err
    if got != pin.target:
        raise PinError(f"{url} locks version {got!r}, not {pin.target}")
    return text if text.endswith("\n") else text + "\n"


def discover(root: pathlib.Path) -> list[Pin]:
    pins: list[Pin] = []
    for file, text in tracked_texts(root):
        lines = text.splitlines()
        rel = file.relative_to(root)
        if file.name == "core.lock.json":
            pins.append(core_lock_pin(file, root, text))
            continue
        if file.name == "package.json" and (file.parent / "package-lock.json").is_file():
            pins.extend(npm_manifest_pins(file, root, text))
            continue
        if file.name == "requirements.in" and file.with_name("requirements.lock").is_file():
            pins.extend(pip_manifest_pins(file, root, text))
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
            value_shape, shape_name = (
                (SHA256, "SHA-256") if pin.is_checksum() or pin.kind == "image-digest"
                else (SNAPSHOT, "snapshot timestamp") if pin.kind == "debian-snapshot"
                else (VERSION, "version"))
            if not value_shape.match(pin.value):
                raise PinError(f"{rel}:{i + 2}: {pin.value!r} is not a {shape_name}")
            pins.append(pin)
    if not pins:
        raise PinError("no upstream markers found — nothing was checked")
    return pins


def resolve(pins: list[Pin], upstream: Upstream) -> None:
    """Set each pin's target. Versions first: a checksum follows its version."""
    for pin in sorted(pins, key=lambda p: p.is_checksum() or p.kind == "image-digest"):
        latest = upstream.latest(pin, pins)
        if pin.is_checksum():
            pin.target = latest
        elif pin.kind == "image-digest":
            pin.target = latest
        elif pin.kind == "debian-snapshot":
            # one weekly wave: a snapshot younger than the limit is current
            old = upstream.clock() - snapshot_epoch(pin.value) > SNAPSHOT_MAX_AGE
            pin.target = latest if old and latest > pin.value else pin.value
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


# --no-build: resolving never runs an sdist's build backend, which would be upstream code
# executing in the job that opens the bump pull request. The environment the tool
# gets carries no GitHub credentials for the same reason.
CREDENTIALS = ("GITHUB_TOKEN", "GH_TOKEN")
PIP_COMPILE = ["pip", "compile", "requirements.in", "--universal", "--python-version", "3.13",
               "--generate-hashes", "--no-header", "--upgrade", "--no-build", "--output-file", "requirements.lock"]


def refresh_lockfile(directory: pathlib.Path, root: pathlib.Path) -> None:
    if (directory / "requirements.in").is_file():
        uv = shutil.which("uv")
        if not uv:
            raise PinError(f"{directory.relative_to(root)}: uv is needed to refresh requirements.lock")
        env = {k: v for k, v in os.environ.items() if k not in CREDENTIALS}
        run = subprocess.run([uv, *PIP_COMPILE], cwd=directory, capture_output=True, text=True, check=False, env=env)
        if run.returncode != 0:
            raise PinError(f"{directory.relative_to(root)}: uv could not refresh requirements.lock: {run.stderr.strip()}")
        print(f"locked   {(directory / 'requirements.lock').relative_to(root)}")
        return
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


def version_moved(pin: Pin, pins: list[Pin]) -> bool | None:
    """Did the version a checksum or digest belongs to move? None for a pin that is not one."""
    if pin.kind == "image-digest":
        owners = [p for p in pins if p.kind == "github-release" and p.args == [pin.args[0]] and pin.args[1] in p.head]
    elif pin.is_checksum():
        owners = [owner_pin(pin, pins)]
    else:
        return None
    return any(o.target != o.value for o in owners)


def cmd_bump(root: pathlib.Path, upstream: Upstream, summary: pathlib.Path | None,
             relock=refresh_lockfile) -> int:
    pins = discover(root)
    resolve(pins, upstream)
    changes = []
    for pin in stale(pins):
        if pin.kind == "core-lock":
            pin.file.write_text(core_lock_asset(pin, upstream))
            changes.append({
                "name": pin.name, "file": str(pin.file.relative_to(root)), "kind": pin.kind,
                "source": " ".join(pin.args), "from": pin.value, "to": pin.target,
                "major": version_key(pin.target)[:2] != version_key(pin.value)[:2],
            })
            print(f"bumped   {label(pin, root)}: {pin.value} -> {pin.target}")
            continue
        lines = pin.file.read_text().splitlines(keepends=True)
        line = lines[pin.line_no - 1]
        ending = line[len(line.rstrip("\r\n")):]
        lines[pin.line_no - 1] = f"{pin.head}{pin.target}{pin.tail}{ending}"
        pin.file.write_text("".join(lines))
        major = pin.kind not in ("debian-snapshot", "image-digest", *CHECKSUM_OWNER) and version_key(pin.target)[0] != version_key(pin.value)[0]
        changes.append({
            "name": pin.name, "file": str(pin.file.relative_to(root)), "kind": pin.kind,
            "source": " ".join(pin.args), "from": pin.value, "to": pin.target, "major": major,
            # a checksum or digest that changed while its version did not: re-published upstream
            "republished": version_moved(pin, pins) is False,
        })
        print(f"bumped   {label(pin, root)}: {pin.value} -> {pin.target}")
    for directory in sorted({p.file.parent for p in stale(pins) if p.file.name in ("package.json", "requirements.in")}):
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
