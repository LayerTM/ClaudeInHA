#!/usr/bin/env bash
# Assembles the add-on tree from this directory's sources and the pinned
# ha-agent-core release. The image build and the test suites both use it, so the
# tree the tests run against is the tree the image ships.
#
#   assemble.sh ARCHIVE SOURCE OUT
#
# ARCHIVE  the release archive named by core.lock.json (downloaded by the caller)
# SOURCE   the add-on directory (the one holding app/ and rootfs/)
# OUT      where the assembled copy goes; must not exist yet
#
# Nothing is merged unless the archive matches the lock (verify-core.js install)
# and the add-on claims no path the core owns (verify-core.js check-assembly).
# The verifier that decides is the reviewed copy beside this script, never the
# one inside the archive.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: assemble.sh ARCHIVE SOURCE OUT" >&2
  exit 2
fi
archive="$1"
source_dir="$2"
out="$3"
here="$(cd "$(dirname "$0")" && pwd)"

# The engine adapter API this add-on's adapter implements. The lock must pin
# it, and the core refuses an adapter declaring anything else.
adapter_api="$(node -p 'require(require("node:path").resolve(process.argv[1]))' "${source_dir}/app/adapter/api-version.js")"

if [ -e "${out}" ]; then
  echo "assemble.sh: ${out} already exists" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

node "${here}/verify-core.js" install --lock "${here}/core.lock.json" \
  --adapter-api "${adapter_api}" --archive "${archive}" --dest "${work}/core"

mkdir -p "${out}"
tar -C "${source_dir}" --exclude=node_modules -cf - . | tar -C "${out}" -xf -

node "${here}/verify-core.js" check-assembly --core "${work}/core" --consumer "${out}"

for part in app ha-tools rootfs; do
  mkdir -p "${out}/${part}"
  cp -R "${work}/core/${part}/." "${out}/${part}/"
done

# The core's checked dependency install, used by the image build and CI in
# app/ and ha-tools/ (see install-tools/npm-ci-checked.sh).
mkdir -p "${out}/install-tools"
for tool in npm-ci-checked.sh check-install-scripts.js build-allowed-packages.js smoke-allowed-packages.js; do
  cp "${work}/core/tools/${tool}" "${out}/install-tools/${tool}"
done

node "${work}/core/tools/check-adapter-graph.js" "${out}/app"
node -e 'require(require("node:path").resolve(process.argv[1])).adapter()' "${out}/app/server/adapter-contract.js"
echo "assembled ha-agent-core $(node -p 'require(process.argv[1]).version' "${here}/core.lock.json") into ${out}"
