#!/usr/bin/env python3
"""The published image a version of this add-on is installed from.

When `claude-code/config.yaml` names an `image:`, the Supervisor stops building
the add-on on the device and pulls `<image>:<version>` instead. That makes one
fact load-bearing: the moment a version is offered (main's config.yaml, which
the add-on store reads), its image must be pullable by an anonymous client. A
merge that offers a version with no image fails every install and update.

The image a release ships is never built for the release. A release pull
request's CI pushes a candidate, `<image>:<version>-rc.<tree>`, built from that
pull request's tree and checked like every other image build; the candidate is
what gets tried before release, and promoting it to `<image>:<version>` copies
that manifest without rebuilding. The tree (not the commit) names it because a
squash merge keeps the tree and changes the commit.

Commands:
  name                      print the image config.yaml names; exit 1 if none
  plan                      print `publish=true|false` for a GitHub output: a
                            candidate is published only for a release pull
                            request from this repository (env EVENT, TITLE,
                            HEAD_REPO, REPO, BASE_CONFIG, CANARY)
  candidate                 print `<image>:<version>-rc.<tree>` for HEAD's tree
  released-ref              print `<image>:<version>`
  pullable <ref>            exit 0 and print the digest if an anonymous client
                            can pull <ref>, 1 if it cannot (denied or not
                            found), 2 if the registry could not be asked
  offered                   exit 0 when the version config.yaml offers is
                            pullable, or when no image is configured; 1 when
                            it is not; 2 when the registry could not be asked
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

import yaml

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from release_notes import RELEASE_TITLE_RE  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
CONFIG = ROOT / "claude-code" / "config.yaml"
ACCEPT = ", ".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])
# registry/namespace/name:tag — the only form this add-on publishes.
REF_RE = re.compile(r"^(?P<registry>[a-z0-9.-]+)/(?P<repo>[a-z0-9._/-]+):(?P<tag>[\w][\w.-]{0,127})$")


def load(path: pathlib.Path) -> dict:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{path} does not contain a mapping")
    return data


def image_of(config: dict) -> str | None:
    """The generic (multi-arch) image name; {arch} names are not published here."""
    image = config.get("image")
    if image is None:
        return None
    if not isinstance(image, str) or "{arch}" in image or image != image.lower() or ":" in image:
        raise SystemExit(
            f"config.yaml image '{image}' must be a lower-case generic name without a tag "
            f"or an {{arch}} placeholder: one multi-arch manifest per version is published"
        )
    return image


def is_release_pr(base_version: str | None, head_version: str | None, title: str) -> bool:
    """True for the pull request that moves the version and is titled for it."""
    if head_version is None or base_version == head_version:
        return False
    match = RELEASE_TITLE_RE.match(title.strip())
    return bool(match and match.group(1) == head_version)


def should_publish(env: dict[str, str], config: dict, base_config: dict | None) -> bool:
    if env.get("CANARY", "false") == "true" or image_of(config) is None:
        return False
    if env.get("EVENT") != "pull_request" or env.get("HEAD_REPO") != env.get("REPO"):
        return False
    base_version = str(base_config["version"]) if base_config and "version" in base_config else None
    return is_release_pr(base_version, str(config.get("version")), env.get("TITLE", ""))


def tree_id() -> str:
    out = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD^{tree}"],
                         capture_output=True, text=True, check=True)
    return out.stdout.strip()


def candidate_tag(version: str, tree: str) -> str:
    return f"{version}-rc.{tree[:12]}"


def split_ref(ref: str) -> tuple[str, str, str]:
    match = REF_RE.match(ref)
    if not match:
        raise SystemExit(f"'{ref}' is not registry/name:tag")
    return match.group("registry"), match.group("repo"), match.group("tag")


def _get(url: str, headers: dict[str, str], method: str = "GET") -> tuple[int, dict[str, str], bytes]:
    request = urllib.request.Request(url, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers or {}), error.read()


def pullable(ref: str, get=_get) -> tuple[int, str]:
    """(0, digest) pullable anonymously; (1, why) denied or missing; (2, why) unknown."""
    registry, repo, tag = split_ref(ref)
    scope = urllib.parse.quote(f"repository:{repo}:pull", safe="")
    try:
        status, _, body = get(f"https://{registry}/token?service={registry}&scope={scope}", {})
        if status in (401, 403):
            return 1, f"{registry}/{repo} refuses anonymous pulls (HTTP {status}): missing or not public"
        if status != 200:
            return 2, f"token request for {repo} answered HTTP {status}"
        token = json.loads(body)["token"]
        status, headers, _ = get(f"https://{registry}/v2/{repo}/manifests/{tag}",
                                 {"Authorization": f"Bearer {token}", "Accept": ACCEPT}, "HEAD")
    except (OSError, ValueError, KeyError) as error:
        return 2, f"could not ask {registry} about {ref}: {error}"
    if status in (401, 403, 404):
        return 1, f"{ref} is not pullable anonymously (HTTP {status})"
    if status != 200:
        return 2, f"{ref}: manifest request answered HTTP {status}"
    digest = {k.lower(): v for k, v in headers.items()}.get("docker-content-digest")
    if not digest:
        return 2, f"{ref}: the registry answered without a digest"
    return 0, digest


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    command, rest = argv[0], argv[1:]
    config = load(CONFIG)
    image = image_of(config)
    version = str(config.get("version"))
    if command == "name":
        if image is None:
            return 1
        print(image)
        return 0
    if command == "plan":
        base_path = os.environ.get("BASE_CONFIG", "")
        base = load(pathlib.Path(base_path)) if base_path and pathlib.Path(base_path).is_file() else None
        print(f"publish={'true' if should_publish(dict(os.environ), config, base) else 'false'}")
        return 0
    if command in ("candidate", "released-ref"):
        if image is None:
            print("config.yaml names no image", file=sys.stderr)
            return 1
        tag = candidate_tag(version, tree_id()) if command == "candidate" else version
        print(f"{image}:{tag}")
        return 0
    if command == "pullable" and len(rest) == 1:
        code, text = pullable(rest[0])
        print(text, file=sys.stdout if code == 0 else sys.stderr)
        return code
    if command == "offered":
        if image is None:
            print("config.yaml names no image: the Supervisor builds the add-on on the device.")
            return 0
        code, text = pullable(f"{image}:{version}")
        if code == 0:
            print(f"{image}:{version} is pullable: {text}")
        else:
            print(f"config.yaml offers {version} from {image}, and users cannot pull it: {text}",
                  file=sys.stderr)
        return code
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
