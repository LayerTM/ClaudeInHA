#!/usr/bin/env python3
"""The published image a version of this add-on is installed from.

When `claude-code/config.yaml` names an `image:`, the Supervisor stops building
the add-on on the device and pulls `<image>:<version>` instead. That makes one
fact load-bearing: the image a version is offered from is the image that was
built from the release's tree by this repository's CI and tried before the
release — and an anonymous client can pull it.

The image a release ships is never built for the release. A release pull
request's CI pushes a candidate, `<image>:<version>-rc.<tree>`, built from that
pull request's tree and checked like every other image build, and attests each
digest it pushed. Promoting a candidate (the `promote-image` workflow, run from
main) copies one named digest to `<image>:<version>` only after proving that
digest: its attestations were signed by this repository's CI from a commit whose
tree is the release's tree, its platforms are the ones that tree declares, and
each platform's image carries that version. The tree (not the commit) names a
candidate because a squash merge keeps the tree and changes the commit.

Every registry write goes through `write()` below, which refuses a tag that is
not the role's own: candidate jobs can only write `-rc.<tree>` tags, and only
the promotion writes `<version>`. A published version never moves, and a
registry answer other than "present" or a definite 404 stops a write.

Commands:
  name                      print the image config.yaml names; exit 1 if none
  platform <arch>           print the Docker platform an architecture builds for
  plan                      print `publish=true|false` (and `image=` when true)
                            for a GitHub output: a candidate is published only
                            for a release pull request from this repository
                            (env EVENT, TITLE, HEAD_REPO, REPO, BASE_CONFIG,
                            CANARY)
  candidate                 print `<image>:<version>-rc.<tree>` for HEAD's tree
  candidate-state <arch>    print `exists=true|false` for that architecture's
                            candidate; exit 2 if the registry cannot tell
  push-candidate <arch>     push the locally built `<candidate>-<arch>`; print
                            `digest=<platform manifest digest>`
  join-candidate <arches>   join the architectures (a JSON list) into the
                            candidate manifest; print `created=` and `digest=`
  promote <version> <tree> <digest>
                            publish `<image>:<version>` from a proven candidate
  release-pr                for a release pull request: `<image>:<version>` is
                            pullable anonymously and is this tree's proven
                            candidate
  pullable <ref>            exit 0 and print the digest if an anonymous client
                            can pull <ref>, 1 if it cannot (denied or not
                            found), 2 if the registry could not be asked
  offered                   exit 0 when the version config.yaml offers is
                            pullable, or when no image is configured; 1 when
                            it is not; 2 when the registry could not be asked

Registry reads use the credentials in env ACTOR/TOKEN when both are set, and an
anonymous token otherwise. Attestations are read with `gh` (env GH_TOKEN); the
repository is env GITHUB_REPOSITORY.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable

import yaml

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from release_notes import RELEASE_TITLE_RE  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
CONFIG = ROOT / "claude-code" / "config.yaml"
# The workflow whose attestations prove a candidate (it builds and checks them).
SIGNER_WORKFLOW = ".github/workflows/ci.yml"
INDEX_TYPES = {
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
}
IMAGE_TYPES = {
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
}
ACCEPT = ", ".join(sorted(INDEX_TYPES) + sorted(IMAGE_TYPES))
# Each architecture the add-on declares, and the platform its image is for.
PLATFORMS = {"amd64": "linux/amd64", "aarch64": "linux/arm64"}
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
TREE_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
CANDIDATE_TAG_RE = re.compile(
    r"^(?P<version>\d+\.\d+\.\d+)-rc\.(?P<tree>[0-9a-f]{40})(?:-(?P<arch>[a-z0-9]+))?$"
)
# registry/namespace/name:tag — the only form this add-on publishes.
REF_RE = re.compile(r"^(?P<registry>[a-z0-9.-]+)/(?P<repo>[a-z0-9._/-]+):(?P<tag>[\w][\w.-]{0,127})$")

Get = Callable[[str, dict, str], tuple]
Gh = Callable[[list], tuple]
Run = Callable[[list], int]


class Refused(Exception):
    """A fact the promotion depends on is false or could not be established."""


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
    if not VERSION_RE.match(version) or not TREE_RE.match(tree):
        raise SystemExit(f"a candidate is named by a version and a full tree id, not '{version}', '{tree}'")
    return f"{version}-rc.{tree}"


def split_ref(ref: str) -> tuple[str, str, str]:
    match = REF_RE.match(ref)
    if not match:
        raise SystemExit(f"'{ref}' is not registry/name:tag")
    return match.group("registry"), match.group("repo"), match.group("tag")


def guard(ref: str, role: str, version: str, tree: str | None = None) -> None:
    """Refuse a write of `ref` that is not the role's own tag."""
    _, _, tag = split_ref(ref)
    if role == "candidate":
        match = CANDIDATE_TAG_RE.match(tag)
        allowed = bool(match and match["version"] == version and match["tree"] == tree)
    elif role == "release":
        allowed = bool(VERSION_RE.match(tag)) and tag == version
    else:
        allowed = False
    if not allowed:
        raise SystemExit(f"refusing to write {ref}: it is not a {role} tag for {version}")


def _get(url: str, headers: dict, method: str = "GET") -> tuple[int, dict, bytes]:
    request = urllib.request.Request(url, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers or {}), error.read()


def _gh(args: list) -> tuple[int, str, str]:
    done = subprocess.run(["gh", *args], check=False, capture_output=True, text=True)
    return done.returncode, done.stdout, done.stderr


def _run(argv: list) -> int:
    print("+ " + " ".join(argv), flush=True)
    return subprocess.run(argv, check=False).returncode


def pullable(ref: str, get: Get = _get) -> tuple[int, str]:
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


class Registry:
    """Reads one repository of a registry; only a 404 means 'absent'."""

    def __init__(self, image: str, auth: tuple[str, str] | None = None, get: Get = _get):
        self.registry, _, self.repo = image.partition("/")
        self.image = image
        self.auth = auth
        self.get = get
        self._token: str | None = None

    def _bearer(self) -> str:
        if self._token is None:
            scope = urllib.parse.quote(f"repository:{self.repo}:pull", safe="")
            headers = {}
            if self.auth:
                pair = f"{self.auth[0]}:{self.auth[1]}".encode()
                headers["Authorization"] = "Basic " + base64.b64encode(pair).decode()
            status, _, body = self.get(
                f"https://{self.registry}/token?service={self.registry}&scope={scope}", headers, "GET")
            if status != 200:
                raise Refused(f"{self.registry} refused a token for {self.repo} (HTTP {status})")
            self._token = json.loads(body)["token"]
        return self._token

    def _fetch(self, kind: str, reference: str) -> tuple[str, str, bytes]:
        """('present', digest, body) | ('absent', why, b'') | ('unknown', why, b'')."""
        where = f"{self.image}{'@' if reference.startswith('sha256:') else ':'}{reference}"
        try:
            status, headers, body = self.get(
                f"https://{self.registry}/v2/{self.repo}/{kind}/{reference}",
                {"Authorization": f"Bearer {self._bearer()}", "Accept": ACCEPT}, "GET")
        except (OSError, ValueError, KeyError, Refused) as error:
            return "unknown", f"could not ask about {where}: {error}", b""
        if status == 404:
            return "absent", f"{where} does not exist (HTTP 404)", b""
        if status != 200:
            return "unknown", f"{where}: the registry answered HTTP {status}", b""
        digest = "sha256:" + hashlib.sha256(body).hexdigest()
        stated = {k.lower(): v for k, v in headers.items()}.get("docker-content-digest")
        if stated and stated != digest:
            return "unknown", f"{where}: the registry states {stated} for content that is {digest}", b""
        if reference.startswith("sha256:") and reference != digest:
            return "unknown", f"{where}: the registry served content that is {digest}", b""
        return "present", digest, body

    def manifest(self, reference: str) -> tuple[str, str, bytes]:
        return self._fetch("manifests", reference)

    def blob(self, digest: str) -> bytes:
        state, text, body = self._fetch("blobs", digest)
        if state != "present":
            raise Refused(text)
        return body

    def require(self, reference: str) -> tuple[str, dict]:
        state, text, body = self.manifest(reference)
        if state != "present":
            raise Refused(text)
        return text, json.loads(body)


def registry_auth(env: dict) -> tuple[str, str] | None:
    if env.get("ACTOR") and env.get("TOKEN"):
        return env["ACTOR"], env["TOKEN"]
    return None


def platform_digest(registry: Registry, reference: str, platform: str) -> str:
    """The image manifest for `platform` behind `reference` (a pushed tag may be an index)."""
    digest, manifest = registry.require(reference)
    if manifest.get("mediaType") in IMAGE_TYPES:
        return digest
    entries = [m for m in manifest.get("manifests", []) if _platform(m) == platform]
    if len(entries) != 1:
        raise Refused(f"{registry.image}:{reference} has {len(entries)} manifests for {platform}")
    return entries[0]["digest"]


def _platform(entry: dict) -> str:
    platform = entry.get("platform") or {}
    return f"{platform.get('os')}/{platform.get('architecture')}"


def _is_attestation_manifest(entry: dict) -> bool:
    return (entry.get("annotations") or {}).get("vnd.docker.reference.type") == "attestation-manifest"


def gh_json(gh: Gh, args: list) -> object:
    code, out, err = gh(args)
    if code != 0:
        raise Refused(f"gh {' '.join(args[:2])} failed: {err.strip() or out.strip()}")
    try:
        return json.loads(out)
    except ValueError as error:
        raise Refused(f"gh {' '.join(args[:2])} answered something that is not JSON: {error}") from error


def config_at_tree(tree: str, repository: str, gh: Gh) -> dict:
    """claude-code/config.yaml as it is in `tree` (content-addressed, so it is that tree's)."""
    entries = gh_json(gh, ["api", f"repos/{repository}/git/trees/{tree}"])["tree"]
    addon = [e for e in entries if e["path"] == "claude-code" and e["type"] == "tree"]
    if len(addon) != 1:
        raise Refused(f"tree {tree} has no claude-code directory")
    entries = gh_json(gh, ["api", f"repos/{repository}/git/trees/{addon[0]['sha']}"])["tree"]
    blob = [e for e in entries if e["path"] == "config.yaml" and e["type"] == "blob"]
    if len(blob) != 1:
        raise Refused(f"tree {tree} has no claude-code/config.yaml")
    content = gh_json(gh, ["api", f"repos/{repository}/git/blobs/{blob[0]['sha']}"])
    data = yaml.safe_load(base64.b64decode(content["content"]))
    if not isinstance(data, dict):
        raise Refused(f"claude-code/config.yaml in {tree} is not a mapping")
    return data


def attested_trees(image: str, digest: str, repository: str, gh: Gh) -> set[str]:
    """The trees whose CI attested `digest`; refused unless every attestation is ours.

    Each attestation must be signed by this repository's CI workflow from the
    same commit it names as its source, so the workflow that signed is the one
    in that commit's tree — the reviewed one, when that tree is the release's.
    """
    found = gh_json(gh, [
        "attestation", "verify", f"oci://{image}@{digest}",
        "--repo", repository,
        "--signer-workflow", f"{repository}/{SIGNER_WORKFLOW}",
        "--deny-self-hosted-runners",
        "--format", "json",
    ])
    if not isinstance(found, list) or not found:
        raise Refused(f"{image}@{digest} has no attestation from {repository}'s CI")
    trees = set()
    for item in found:
        result = item["verificationResult"]
        certificate = result["signature"]["certificate"]
        subjects = {"sha256:" + s["digest"]["sha256"] for s in result["statement"]["subject"]}
        if digest not in subjects:
            raise Refused(f"an attestation returned for {digest} is about {sorted(subjects)}")
        if certificate.get("sourceRepositoryURI") != f"https://github.com/{repository}":
            raise Refused(f"{digest} was attested from {certificate.get('sourceRepositoryURI')}")
        commit = certificate.get("sourceRepositoryDigest", "")
        if not re.match(r"^[0-9a-f]{40}$", commit) or certificate.get("buildSignerDigest") != commit:
            raise Refused(f"{digest} was attested by a workflow from another commit than its source {commit}")
        trees.add(gh_json(gh, ["api", f"repos/{repository}/git/commits/{commit}"])["tree"]["sha"])
    return trees


def prove(version: str, tree: str, digest: str, repository: str, registry_for, gh: Gh) -> tuple[Registry, list]:
    """The proven candidate's registry, or Refused naming the first fact that fails."""
    if not VERSION_RE.match(version) or not TREE_RE.match(tree) or not DIGEST_RE.match(digest):
        raise Refused(f"want a version, a 40-hex tree and a sha256 digest; got '{version}' '{tree}' '{digest}'")
    config = config_at_tree(tree, repository, gh)
    if str(config.get("version")) != version:
        raise Refused(f"tree {tree} is version {config.get('version')}, not {version}")
    image = image_of(config)
    if image is None:
        raise Refused(f"tree {tree} names no image")
    arches = [str(a) for a in config.get("arch") or []]
    if not arches or any(a not in PLATFORMS for a in arches):
        raise Refused(f"tree {tree} declares architectures {arches}; platforms are known for {sorted(PLATFORMS)}")
    registry = registry_for(image)

    candidate_digest, _ = registry.require(candidate_tag(version, tree))
    if candidate_digest != digest:
        raise Refused(f"{image}:{candidate_tag(version, tree)} is {candidate_digest}, not {digest}")
    _, index = registry.require(digest)
    if index.get("mediaType") not in INDEX_TYPES:
        raise Refused(f"{image}@{digest} is not a multi-architecture manifest")
    entries = [m for m in index.get("manifests", []) if not _is_attestation_manifest(m)]
    by_platform = {_platform(m): m["digest"] for m in entries}
    want = {PLATFORMS[a]: a for a in arches}
    if len(by_platform) != len(entries) or set(by_platform) != set(want):
        raise Refused(f"{image}@{digest} is for {sorted(_platform(m) for m in entries)}, "
                      f"the tree declares {sorted(want)}")
    if attested_trees(image, digest, repository, gh) != {tree}:
        raise Refused(f"{image}@{digest} was not attested as built from tree {tree} only")
    for platform, arch in sorted(want.items()):
        image_digest = by_platform[platform]
        if attested_trees(image, image_digest, repository, gh) != {tree}:
            raise Refused(f"{platform} image {image_digest} was not attested as built from tree {tree} only")
        _, manifest = registry.require(image_digest)
        labels = (json.loads(registry.blob(manifest["config"]["digest"])).get("config") or {}).get("Labels") or {}
        if labels.get("io.hass.version") != version or labels.get("io.hass.arch") != arch:
            raise Refused(f"{platform} image {image_digest} is labelled "
                          f"{labels.get('io.hass.version')}/{labels.get('io.hass.arch')}, not {version}/{arch}")
    return registry, arches


def promote(version: str, tree: str, digest: str, env: dict, registry_for, gh: Gh = _gh, run: Run = _run) -> int:
    """Publish `<image>:<version>` as `digest` once `digest` is proven; never move it."""
    if env.get("GITHUB_REF") != "refs/heads/main":
        print(f"a release is promoted only by main's workflow, not from {env.get('GITHUB_REF')}", file=sys.stderr)
        return 1
    try:
        registry, _ = prove(version, tree, digest, env["GITHUB_REPOSITORY"], registry_for, gh)
    except (Refused, KeyError, ValueError) as error:
        print(f"not promoting {version}: {error}", file=sys.stderr)
        return 1
    released = f"{registry.image}:{version}"
    state, text, _ = registry.manifest(version)
    if state == "present":
        if text == digest:
            print(f"{released} is already {digest}.")
            return 0
        print(f"{released} is already {text}; a published version never moves.", file=sys.stderr)
        return 1
    if state != "absent":
        print(f"not promoting: {text}", file=sys.stderr)
        return 1
    if write(["docker", "buildx", "imagetools", "create", "--tag", released, f"{registry.image}@{digest}"],
             released, "release", version, run=run) != 0:
        return 1
    state, now, _ = registry.manifest(version)
    if state != "present" or now != digest:
        print(f"{released} reads as {state} {now} after the copy, not {digest}", file=sys.stderr)
        return 1
    print(f"{released} = {registry.image}:{candidate_tag(version, tree)} = {digest}")
    return 0


def write(argv: list, ref: str, role: str, version: str, tree: str | None = None, run: Run = _run) -> int:
    """The one place a tag is written; it refuses any tag that is not the role's."""
    guard(ref, role, version, tree)
    return run(argv)


def release_pr(image: str, version: str, tree: str, env: dict, registry_for, gh: Gh = _gh, get: Get = _get) -> int:
    """A release pull request offers `<image>:<version>`: it must be pullable and be this tree's proven candidate."""
    code, text = pullable(f"{image}:{version}", get)
    if code != 0:
        print(f"{image}:{version} is not pullable without credentials ({text}); "
              f"promote this tree's proven candidate first", file=sys.stderr)
        return code
    try:
        prove(version, tree, text, env["GITHUB_REPOSITORY"], registry_for, gh)
    except (Refused, KeyError, ValueError) as error:
        print(f"{image}:{version} is {text}, which is not this tree's proven candidate: {error}",
              file=sys.stderr)
        return 1
    print(f"{image}:{version} is {text}, this tree's proven candidate.")
    return 0


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    command, rest = argv[0], argv[1:]
    env = dict(os.environ)
    if command == "platform" and len(rest) == 1:
        if rest[0] not in PLATFORMS:
            print(f"No Docker platform is mapped for '{rest[0]}': add it to PLATFORMS rather than "
                  f"dropping the architecture.", file=sys.stderr)
            return 1
        print(PLATFORMS[rest[0]])
        return 0
    config = load(CONFIG)
    image = image_of(config)
    version = str(config.get("version"))

    def registry_for(name: str) -> Registry:
        return Registry(name, registry_auth(env))

    if command == "name":
        if image is None:
            return 1
        print(image)
        return 0
    if command == "plan":
        base_path = env.get("BASE_CONFIG", "")
        base = load(pathlib.Path(base_path)) if base_path and pathlib.Path(base_path).is_file() else None
        publish = should_publish(env, config, base)
        print(f"publish={'true' if publish else 'false'}")
        if publish:
            print(f"image={image}")
        return 0
    if command == "promote" and len(rest) == 3:
        return promote(rest[0], rest[1], rest[2], env, registry_for)
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
    if image is None:
        print("config.yaml names no image", file=sys.stderr)
        return 1
    tree = tree_id()
    candidate = f"{image}:{candidate_tag(version, tree)}"
    if command == "candidate":
        print(candidate)
        return 0
    if command == "release-pr":
        return release_pr(image, version, tree, env, registry_for)
    registry = registry_for(image)
    if command == "candidate-state" and len(rest) == 1:
        state, text, _ = registry.manifest(f"{candidate_tag(version, tree)}-{rest[0]}")
        if state == "unknown":
            print(text, file=sys.stderr)
            return 2
        print(f"exists={'true' if state == 'present' else 'false'}")
        return 0
    if command == "push-candidate" and len(rest) == 1:
        return push_candidate(registry, version, tree, rest[0])
    if command == "join-candidate" and len(rest) == 1:
        return join_candidate(registry, version, tree, json.loads(rest[0]))
    print(__doc__, file=sys.stderr)
    return 2


def push_candidate(registry: Registry, version: str, tree: str, arch: str, run: Run = _run) -> int:
    """Push the checked image for `arch`; a tag that already exists is never replaced."""
    tag = f"{candidate_tag(version, tree)}-{arch}"
    ref = f"{registry.image}:{tag}"
    state, text, _ = registry.manifest(tag)
    if state != "absent":
        print(f"not pushing {ref}: {'it exists' if state == 'present' else text}", file=sys.stderr)
        return 1
    if write(["docker", "push", ref], ref, "candidate", version, tree, run=run) != 0:
        return 1
    try:
        digest = platform_digest(registry, tag, PLATFORMS[arch])
    except Refused as error:
        print(f"pushed {ref} but cannot read it back: {error}", file=sys.stderr)
        return 1
    print(f"digest={digest}")
    return 0


def join_candidate(registry: Registry, version: str, tree: str, arches: list, run: Run = _run) -> int:
    """Join each architecture's candidate into one manifest; an existing one is kept as it is."""
    tag = candidate_tag(version, tree)
    ref = f"{registry.image}:{tag}"
    state, text, _ = registry.manifest(tag)
    if state == "present":
        print(f"{ref} exists and is kept; it is attested only by the run that created it.", file=sys.stderr)
        print("created=false")
        print(f"digest={text}")
        return 0
    if state != "absent":
        print(text, file=sys.stderr)
        return 1
    try:
        sources = [f"{registry.image}@{platform_digest(registry, f'{tag}-{a}', PLATFORMS[a])}" for a in arches]
    except (Refused, KeyError) as error:
        print(f"cannot join {ref}: {error}", file=sys.stderr)
        return 1
    if write(["docker", "buildx", "imagetools", "create", "--tag", ref, *sources],
             ref, "candidate", version, tree, run=run) != 0:
        return 1
    state, digest, _ = registry.manifest(tag)
    if state != "present":
        print(f"{ref} reads as {state} after the join: {digest}", file=sys.stderr)
        return 1
    print("created=true")
    print(f"digest={digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
