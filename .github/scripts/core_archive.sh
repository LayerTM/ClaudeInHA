#!/usr/bin/env bash
# Puts the ha-agent-core archive pinned by claude-code/core/core.lock.json at
# DIR/core.tar and prints where it came from on stdout (`release` or `packed`).
#
#   core_archive.sh DIR
#
# The published release asset is used whenever the release exists. Before the
# pinned version is released, the archive is packed from the pinned commit with
# that commit's own packer, which reproduces the release asset byte for byte.
# Either way nothing is trusted on the strength of where it came from: the
# assembly verifies it against the digest in the lock, and the `core-release`
# job keeps a pin to an unreleased version from being merged.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: core_archive.sh DIR" >&2
  exit 2
fi
dest="$1"
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
lock="${repo_root}/claude-code/core/core.lock.json"
verifier="${repo_root}/claude-code/core/verify-core.js"

url="$(node "${verifier}" url --lock "${lock}")"
version="$(node -p 'require(process.argv[1]).version' "${lock}")"
commit="$(node -p 'require(process.argv[1]).commit' "${lock}")"
mkdir -p "${dest}"

if gh release view "v${version}" --repo LayerTM/ha-agent-core >/dev/null 2>&1; then
  curl -fsSL --proto '=https' --retry 3 --retry-delay 2 -o "${dest}/core.tar" "${url}" >&2
  echo release
  exit 0
fi

echo "::notice::ha-agent-core v${version} is not released yet; packing the pinned commit ${commit}" >&2
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
git clone --quiet https://github.com/LayerTM/ha-agent-core.git "${work}/core" >&2
git -C "${work}/core" checkout --quiet --detach "${commit}" >&2
(cd "${work}/core" && node tools/pack.js --commit "${commit}" --out "${work}/out") >&2
cp "${work}/out/ha-agent-core-${version}.tar" "${dest}/core.tar"
echo packed
