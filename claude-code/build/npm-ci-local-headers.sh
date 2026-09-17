#!/usr/bin/env bash
# npm ci for a package with native dependencies, built against the headers of the
# Node that runs it. The image build and CI both install through this script.
#
#   npm-ci-local-headers.sh [npm ci arguments...]
#
# node-pty ships no Linux prebuilds, so node-gyp compiles it; by default node-gyp
# first downloads the headers from nodejs.org, which makes the install depend on
# that download. Every Node release archive already carries them under
# include/node, so node-gyp is pointed there and given an empty download
# directory that must still be absent afterwards.
set -euo pipefail

npm_config_nodedir="$(node -p 'path.dirname(path.dirname(process.execPath))')"
test -f "${npm_config_nodedir}/include/node/common.gypi" || {
  echo "no Node headers under ${npm_config_nodedir}/include/node" >&2
  exit 1
}
download_root="$(mktemp -d)"
trap 'rm -rf "${download_root}"' EXIT
npm_config_devdir="${download_root}/node-gyp"
export npm_config_nodedir npm_config_devdir

npm ci "$@"

if [ -e "${npm_config_devdir}" ]; then
  echo "node-gyp downloaded headers instead of using ${npm_config_nodedir}" >&2
  exit 1
fi
