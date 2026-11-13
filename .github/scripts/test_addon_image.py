#!/usr/bin/env python3
"""Self-test for addon_image.py — which image a version is installed from.

What matters is what it refuses: publishing a candidate from anything but a
release pull request of this repository, an image name the Supervisor would
resolve differently, calling a version pullable when a device without
credentials could not pull it, and publishing a version from a digest it has
not proven — or over a version that already exists, or when the registry
cannot say whether it does.

Run: python3 .github/scripts/test_addon_image.py
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import io
import json
import pathlib
import sys

import yaml

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import addon_image  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]

fails = 0


def check(label: str, got, want) -> None:
    global fails
    if got == want:
        print(f"  ok  - {label}")
    else:
        fails += 1
        print(f"  FAIL - {label}: got {got!r}, want {want!r}")


def refused(label: str, config: dict) -> None:
    try:
        addon_image.image_of(config)
    except SystemExit:
        check(label, "refused", "refused")
    else:
        check(label, "accepted", "refused")


print("The image name")
check("no image means a device build", addon_image.image_of({"version": "1.0.0"}), None)
check("a generic name", addon_image.image_of({"image": "ghcr.io/layertm/claude-code"}), "ghcr.io/layertm/claude-code")
refused("an {arch} name", {"image": "ghcr.io/layertm/{arch}-claude-code"})
refused("upper case", {"image": "ghcr.io/LayerTM/claude-code"})
refused("a tag", {"image": "ghcr.io/layertm/claude-code:1.0.0"})

print("Only a release pull request of this repository publishes a candidate")
config = {"version": "1.64.0", "image": "ghcr.io/layertm/claude-code"}
base = {"version": "1.63.3"}
release = {"EVENT": "pull_request", "TITLE": "Release 1.64.0", "HEAD_REPO": "o/r", "REPO": "o/r"}
check("the release pull request", addon_image.should_publish(release, config, base), True)
check("a canary build", addon_image.should_publish({**release, "CANARY": "true"}, config, base), False)
check("a fork", addon_image.should_publish({**release, "HEAD_REPO": "x/r"}, config, base), False)
check("a push", addon_image.should_publish({**release, "EVENT": "push"}, config, base), False)
check("another title", addon_image.should_publish({**release, "TITLE": "Fix a thing"}, config, base), False)
check("a title for another version", addon_image.should_publish({**release, "TITLE": "Release 1.64.01"}, config, base), False)
check("the version did not move", addon_image.should_publish(release, config, {"version": "1.64.0"}), False)
check("no image configured", addon_image.should_publish(release, {"version": "1.64.0"}, base), False)

print("The candidate is named by the full tree")
check("tag", addon_image.candidate_tag("1.64.0", "0123456789abcdef0123456789abcdef01234567"),
      "1.64.0-rc.0123456789abcdef0123456789abcdef01234567")
try:
    addon_image.candidate_tag("1.64.0", "0123456789ab")
    check("a short tree is refused", "accepted", "refused")
except SystemExit:
    check("a short tree is refused", "refused", "refused")


def registry(token_status=200, manifest_status=200, digest="sha256:abc"):
    calls = []

    def get(url, headers, method="GET"):
        calls.append((method, url, headers.get("Authorization")))
        if "/token?" in url:
            return token_status, {}, json.dumps({"token": "t"}).encode()
        return manifest_status, ({"Docker-Content-Digest": digest} if digest else {}), b""

    return get, calls


print("Pullable means pullable without credentials")
get, calls = registry()
check("found", addon_image.pullable("ghcr.io/layertm/claude-code:1.64.0", get), (0, "sha256:abc"))
check("asks for the manifest by tag", calls[-1][:2], ("HEAD", "https://ghcr.io/v2/layertm/claude-code/manifests/1.64.0"))
check("with the anonymous token", calls[-1][2], "Bearer t")
check("a private or missing package", addon_image.pullable("ghcr.io/a/b:1", registry(token_status=403)[0])[0], 1)
check("a missing tag", addon_image.pullable("ghcr.io/a/b:1", registry(manifest_status=404)[0])[0], 1)
check("a registry error is not 'missing'", addon_image.pullable("ghcr.io/a/b:1", registry(manifest_status=503)[0])[0], 2)
check("a token error is not 'missing'", addon_image.pullable("ghcr.io/a/b:1", registry(token_status=500)[0])[0], 2)
check("no digest is not 'found'", addon_image.pullable("ghcr.io/a/b:1", registry(digest=None)[0])[0], 2)


def unreachable(url, headers, method="GET"):
    raise OSError("network is unreachable")


check("no network is not 'missing'", addon_image.pullable("ghcr.io/a/b:1", unreachable)[0], 2)


# A registry, GitHub and docker that keep their state in memory. Nothing here
# reaches a network; `run` records every write instead of doing it.
VERSION = "1.64.0"
TREE = "a" * 40
OTHER_TREE = "b" * 40
COMMIT = "c" * 40
OTHER_COMMIT = "d" * 40
REPO = "o/r"
IMAGE = "ghcr.io/o/addon"
MAIN = {"GITHUB_REF": "refs/heads/main", "GITHUB_REPOSITORY": REPO}


def _blob(obj) -> tuple[str, bytes]:
    body = json.dumps(obj, sort_keys=True).encode()
    return "sha256:" + hashlib.sha256(body).hexdigest(), body


class World:
    def __init__(self, version=VERSION, arches=("amd64", "aarch64"), labelled=VERSION, tree_version=VERSION):
        self.objects: dict[str, bytes] = {}
        self.tags: dict[str, str] = {}
        self.status: dict[str, int] = {}     # reference -> forced HTTP status
        self.token_status = 200
        self.writes: list[list] = []
        self.gh_calls: list[list] = []
        self.urls: list[str] = []
        self.attested: dict[str, tuple[str, str, str]] = {}   # digest -> (commit, signer digest, repo URI)
        self.commit_tree = {COMMIT: TREE, OTHER_COMMIT: OTHER_TREE}
        self.tree_config = {"version": tree_version, "image": IMAGE, "arch": ["aarch64", "amd64"]}
        entries = []
        self.platform = {}
        for arch in arches:
            config_digest, config_body = _blob({"config": {"Labels": {"io.hass.version": labelled, "io.hass.arch": arch}}})
            self.objects[config_digest] = config_body
            digest, body = _blob({"mediaType": "application/vnd.docker.distribution.manifest.v2+json",
                                  "config": {"digest": config_digest}})
            self.objects[digest] = body
            self.platform[arch] = digest
            os_arch = addon_image.PLATFORMS[arch].split("/")
            entries.append({"digest": digest, "platform": {"os": os_arch[0], "architecture": os_arch[1]}})
            self.attested[digest] = (COMMIT, COMMIT, f"https://github.com/{REPO}")
        self.index, body = _blob({"mediaType": "application/vnd.oci.image.index.v1+json", "manifests": entries})
        self.objects[self.index] = body
        self.attested[self.index] = (COMMIT, COMMIT, f"https://github.com/{REPO}")
        self.tags[f"{version}-rc.{TREE}"] = self.index

    def get(self, url, headers, method="GET"):
        self.urls.append(url)
        if "/token?" in url:
            return self.token_status, {}, json.dumps({"token": "t"}).encode()
        reference = url.rsplit("/", 1)[1]
        if reference in self.status:
            return self.status[reference], {}, b""
        digest = reference if reference.startswith("sha256:") else self.tags.get(reference)
        if digest is None or digest not in self.objects:
            return 404, {}, b'{"errors":[{"code":"MANIFEST_UNKNOWN"}]}'
        return 200, {"Docker-Content-Digest": digest}, b"" if method == "HEAD" else self.objects[digest]

    def registry_for(self, image):
        return addon_image.Registry(image, ("actor", "token"), self.get)

    def gh(self, args):
        self.gh_calls.append(args)
        if args[:2] == ["attestation", "verify"]:
            digest = args[2].rsplit("@", 1)[1]
            if digest not in self.attested:
                return 1, "", "no attestations found"
            commit, signer, uri = self.attested[digest]
            return 0, json.dumps([{"verificationResult": {
                "signature": {"certificate": {"sourceRepositoryDigest": commit, "buildSignerDigest": signer,
                                              "sourceRepositoryURI": uri}},
                "statement": {"subject": [{"name": IMAGE, "digest": {"sha256": digest.split(":")[1]}}]}}}]), ""
        path = args[1]
        if path == f"repos/{REPO}/git/trees/{TREE}":
            return 0, json.dumps({"tree": [{"path": "claude-code", "type": "tree", "sha": "addon"}]}), ""
        if path == f"repos/{REPO}/git/trees/addon":
            return 0, json.dumps({"tree": [{"path": "config.yaml", "type": "blob", "sha": "cfg"}]}), ""
        if path == f"repos/{REPO}/git/blobs/cfg":
            content = base64.b64encode(yaml.safe_dump(self.tree_config).encode()).decode()
            return 0, json.dumps({"content": content}), ""
        if path.startswith(f"repos/{REPO}/git/commits/"):
            commit = path.rsplit("/", 1)[1]
            return 0, json.dumps({"tree": {"sha": self.commit_tree[commit]}}), ""
        return 1, "", "not found"

    def run(self, argv):
        self.writes.append(argv)
        if argv[:4] == ["docker", "buildx", "imagetools", "create"]:
            tag = argv[5].rsplit(":", 1)[1]
            sources = [s.rsplit("@", 1)[1] for s in argv[6:]]
            if len(sources) == 1:
                self.tags[tag] = sources[0]
            else:
                digest, body = _blob({"mediaType": "application/vnd.oci.image.index.v1+json",
                                      "manifests": [{"digest": d, "platform": {}} for d in sources]})
                self.objects[digest] = body
                self.tags[tag] = digest
        if argv[:2] == ["docker", "push"]:
            tag = argv[2].rsplit(":", 1)[1]
            arch = tag.rsplit("-", 1)[1]
            self.tags[tag] = self.platform[arch]
        return 0


def promote(world, digest=None, env=MAIN, version=VERSION, tree=TREE):
    quiet = io.StringIO()
    with contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
        return addon_image.promote(version, tree, digest or world.index, env, world.registry_for, world.gh, world.run)


print("Promotion publishes a proven candidate, once")
w = World()
check("a proven candidate is published", promote(w), 0)
check("with one copy of that digest", w.writes, [["docker", "buildx", "imagetools", "create", "--tag",
                                                  f"{IMAGE}:{VERSION}", f"{IMAGE}@{w.index}"]])
check("the version is that digest", w.tags.get(VERSION), w.index)
check("running it again is a no-op", (promote(w), len(w.writes)), (0, 1))

print("Promotion refuses, and writes nothing, when a fact is missing")


def refuses(label, world, **kwargs):
    before = world.tags.get(VERSION)
    code = promote(world, **kwargs)
    check(label, (code, world.writes, world.tags.get(VERSION)), (1, [], before))


w = World()
w.tags[VERSION] = w.platform["amd64"]
refuses("the version already names another digest", w)
w = World()
w.status[VERSION] = 503
refuses("the registry cannot say whether the version exists", w)
w = World()
w.status[VERSION] = 401
refuses("the registry denies the read", w)
w = World()
w.token_status = 500
refuses("the registry gives no token", w)
w = World()
del w.attested[w.index]
refuses("an unattested digest", w)
w = World()
del w.attested[w.platform["aarch64"]]
refuses("a platform image is unattested", w)
w = World()
w.attested[w.index] = (OTHER_COMMIT, OTHER_COMMIT, f"https://github.com/{REPO}")
refuses("an attestation for another tree", w)
w = World()
w.attested[w.index] = (COMMIT, OTHER_COMMIT, f"https://github.com/{REPO}")
refuses("signed by a workflow from another commit", w)
w = World()
w.attested[w.index] = (COMMIT, COMMIT, "https://github.com/x/r")
refuses("attested from another repository", w)
w = World()
w.tags[f"{VERSION}-rc.{TREE}"] = w.platform["amd64"]
refuses("the tree's candidate is another digest", w)
w = World(arches=("amd64",))
refuses("a platform the tree declares is missing", w)
w = World(labelled="1.63.0")
refuses("images labelled with another version", w)
w = World(tree_version="1.63.0")
refuses("the tree is another version", w)
w = World()
refuses("an input tree that is not the full id", w, tree=TREE[:12])
w = World()
refuses("a digest that is not a sha256", w, digest="latest")
w = World()
w.tree_config["image"] = "evil.example/o/addon"
refuses("a tree whose image is outside this repository's namespace", w)
check("and nothing was asked of any registry", w.urls, [])
w = World()
check("not from main", (promote(w, env={**MAIN, "GITHUB_REF": "refs/heads/x"}), w.writes, w.gh_calls), (1, [], []))
w = World()
w.objects[w.index] = w.objects[w.index] + b" "
refuses("content that does not match its digest", w)

print("Credentials go only to this repository's own namespace")
creds = {"ACTOR": "a", "TOKEN": "t", "GITHUB_REPOSITORY": "Owner/r"}
check("its own image", addon_image.registry_auth(creds, "ghcr.io/owner/addon"), ("a", "t"))
check("another owner's image", addon_image.registry_auth(creds, "ghcr.io/other/addon"), None)
check("another registry", addon_image.registry_auth(creds, "evil.example/owner/addon"), None)
check("a look-alike host", addon_image.registry_auth(creds, "ghcr.io.evil.example/owner/addon"), None)

print("Writes go only to the role's own tags")


def guarded(label, ref, role, tree=TREE, want="refused"):
    try:
        addon_image.guard(ref, role, VERSION, tree)
        got = "allowed"
    except SystemExit:
        got = "refused"
    check(label, got, want)


guarded("a candidate tag", f"{IMAGE}:{VERSION}-rc.{TREE}-amd64", "candidate", want="allowed")
guarded("a candidate manifest", f"{IMAGE}:{VERSION}-rc.{TREE}", "candidate", want="allowed")
guarded("a candidate never writes the version", f"{IMAGE}:{VERSION}", "candidate")
guarded("a candidate never writes latest", f"{IMAGE}:latest", "candidate")
guarded("a candidate never writes another tree", f"{IMAGE}:{VERSION}-rc.{OTHER_TREE}", "candidate")
guarded("a candidate never writes a short tree", f"{IMAGE}:{VERSION}-rc.{TREE[:12]}", "candidate")
guarded("a candidate never writes another version", f"{IMAGE}:1.65.0-rc.{TREE}", "candidate")
guarded("a release writes its version", f"{IMAGE}:{VERSION}", "release", want="allowed")
guarded("a release never writes a candidate", f"{IMAGE}:{VERSION}-rc.{TREE}", "release")
guarded("a release never writes another version", f"{IMAGE}:1.65.0", "release")


def quietly(fn, *args):
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
        code = fn(*args)
    return code, out.getvalue()


print("A candidate is pushed once and never replaced")
w = World()
del w.tags[f"{VERSION}-rc.{TREE}"]
registry = w.registry_for(IMAGE)
code, out = quietly(addon_image.push_candidate, registry, VERSION, TREE, "amd64", w.run)
check("an absent architecture is pushed", (code, w.writes), (0, [["docker", "push", f"{IMAGE}:{VERSION}-rc.{TREE}-amd64"]]))
check("and its platform digest is reported", out.strip(), f"digest={w.platform['amd64']}")
check("an existing one is not pushed again",
      (quietly(addon_image.push_candidate, registry, VERSION, TREE, "amd64", w.run)[0], len(w.writes)), (1, 1))
w.status[f"{VERSION}-rc.{TREE}-aarch64"] = 500
check("an unknown state is not pushed over",
      (quietly(addon_image.push_candidate, registry, VERSION, TREE, "aarch64", w.run)[0], len(w.writes)), (1, 1))
del w.status[f"{VERSION}-rc.{TREE}-aarch64"]
quietly(addon_image.push_candidate, registry, VERSION, TREE, "aarch64", w.run)
code, out = quietly(addon_image.join_candidate, registry, VERSION, TREE, ["amd64", "aarch64"], w.run)
check("the architectures are joined by digest", (code, w.writes[-1][6:]),
      (0, [f"{IMAGE}@{w.platform['amd64']}", f"{IMAGE}@{w.platform['aarch64']}"]))
check("a joined manifest is new", "created=true" in out, True)
code, out = quietly(addon_image.join_candidate, registry, VERSION, TREE, ["amd64", "aarch64"], w.run)
check("an existing manifest is kept, and not attested again", (code, "created=false" in out, len(w.writes)), (0, True, 3))

print("A release pull request's image is its own proven candidate")


def release_pr(world):
    quiet = io.StringIO()
    with contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
        return addon_image.release_pr(IMAGE, VERSION, TREE, MAIN, world.registry_for, world.gh, world.get)


w = World()
check("not yet promoted", release_pr(w), 1)
w.tags[VERSION] = w.index
check("promoted from this tree's candidate", release_pr(w), 0)
w = World()
w.tags[VERSION] = w.platform["amd64"]
check("published from something else", release_pr(w), 1)
w = World()
w.tags[VERSION] = w.index
w.status[VERSION] = 503
check("the registry cannot be asked", release_pr(w), 2)

print("No workflow writes an image tag except through this script")
for workflow in sorted((ROOT / ".github" / "workflows").glob("*.yml")):
    text = workflow.read_text(encoding="utf-8")
    raw = [w for w in ("docker push", "imagetools create", "docker tag") if w in text]
    check(f"{workflow.name} has no raw registry write", raw, [])
promote_wf = yaml.safe_load((ROOT / ".github" / "workflows" / "promote-image.yml").read_text(encoding="utf-8"))
job = promote_wf["jobs"]["promote"]
check("promotion runs only from main", job.get("if"), "github.ref == 'refs/heads/main'")
check("one promotion per version at a time", promote_wf["concurrency"],
      {"group": "promote-image-${{ inputs.version }}", "cancel-in-progress": False})
check("its inputs", sorted(promote_wf[True]["workflow_dispatch"]["inputs"]), ["digest", "tree", "version"])

print(f"\n{'FAILED' if fails else 'ok'} — {fails} failing check(s)")
sys.exit(1 if fails else 0)
