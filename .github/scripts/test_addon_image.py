#!/usr/bin/env python3
"""Self-test for addon_image.py — which image a version is installed from.

What matters is what it refuses: publishing a candidate from anything but a
release pull request of this repository, an image name the Supervisor would
resolve differently, and calling a version pullable when a device without
credentials could not pull it.

Run: python3 .github/scripts/test_addon_image.py
"""

from __future__ import annotations

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import addon_image  # noqa: E402

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

print("The candidate is named by the tree")
check("tag", addon_image.candidate_tag("1.64.0", "0123456789abcdef0123"), "1.64.0-rc.0123456789ab")


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

print(f"\n{'FAILED' if fails else 'ok'} — {fails} failing check(s)")
sys.exit(1 if fails else 0)
