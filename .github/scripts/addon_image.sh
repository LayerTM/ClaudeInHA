#!/usr/bin/env bash
# Build the add-on image for one architecture and check that it runs what it
# ships. CI's test build and the candidate a release pull request publishes go
# through this one script, so the image users get is built and checked exactly
# like the one every pull request is measured with.
#
# Usage:
#   addon_image.sh build <arch> <tag>
#   addon_image.sh check <arch> <tag>
# Needs GH_TOKEN for the core download; run from the repository root.
set -euo pipefail

command="${1:?build|check}"
arch="${2:?arch}"
tag="${3:?tag}"

# One mapping from architecture to platform, shared with the candidate checks.
platform="$(python3 .github/scripts/addon_image.py platform "${arch}")"

build() {
  # Building arm64 under QEMU would still go green while taking half an hour
  # and exercising a different code path than users get. If the native runner
  # is unavailable this must fail loudly, not quietly emulate.
  local have
  have="linux/$(dpkg --print-architecture)"
  if [ "${platform}" != "${have}" ]; then
    echo "This runner is ${have} but the build must be ${platform}."
    echo "Give this architecture a runner that matches it."
    exit 1
  fi
  local from version source
  from="$(python3 .github/scripts/addon_arches.py --build-from "${arch}")"
  version="$(python3 .github/scripts/release_notes.py version claude-code/config.yaml)"
  # Once the pinned core is released the image fetches it itself, as it does
  # on a user's device; before that, the packed archive stands in for the
  # download and is still checked against the lock.
  source="$(.github/scripts/core_archive.sh "${RUNNER_TEMP}/core")"
  local archive=()
  if [ "${source}" = packed ]; then
    archive=(--build-context "core-archive=${RUNNER_TEMP}/core")
  fi
  # The labels the Supervisor reads from an installed image (its version and
  # architecture) and the one that links the package to this repository.
  docker build --pull \
    "${archive[@]}" \
    --platform "${platform}" \
    --build-arg BUILD_FROM="${from}" \
    --label "io.hass.version=${version}" \
    --label "io.hass.arch=${arch}" \
    --label "io.hass.type=app" \
    --label "io.hass.name=Claude Code" \
    --label "io.hass.url=https://github.com/LayerTM/ClaudeInHA" \
    --label "org.opencontainers.image.source=https://github.com/LayerTM/ClaudeInHA" \
    --label "org.opencontainers.image.version=${version}" \
    --tag "${tag}" \
    claude-code
}

check() {
  # A build that succeeds and produces a binary that cannot execute on this
  # architecture is the exact failure a user would hit, so ask the image, not
  # the builder.
  docker run --rm --network none --platform "${platform}" \
    --entrypoint /root/.local/bin/claude "${tag}" --version
  docker run --rm --network none --platform "${platform}" \
    --entrypoint /usr/local/bin/node "${tag}" \
    -e "require('/opt/agent-console/node_modules/node-pty').spawn('/bin/true', [], {}).onExit(({ exitCode }) => { console.log('node-pty spawns, exit ' + exitCode); process.exit(exitCode); })"
  # The bundled CLI accepts every argument list the prompt runner builds. The
  # lists come from the core and the adapter inside the image, not from a copy,
  # so a CLI bump that drops or renames a flag fails here instead of turning
  # every chat request into an error.
  docker run --rm --network none --platform "${platform}" \
    --volume "${PWD}/.github/scripts:/ci:ro" \
    --entrypoint /usr/local/bin/node "${tag}" \
    /ci/runner_args_smoke.js /root/.local/bin/claude /opt/agent-console
  # The bundled CLI still clears a warm session before its next question:
  # prompt_keep_warm answers a question from a process that answered the
  # previous one, trusting the CLI to clear the conversation in between. The
  # CLI is named by path: the adapter's own path is the copy kept under /data
  # on a device, which a fresh image does not have.
  docker run --rm --network none --platform "${platform}" \
    --entrypoint /usr/local/bin/node "${tag}" \
    /opt/agent-console/server/prompt/session-check.js --bin /root/.local/bin/claude
  # Start-up, launch, update and digest behave as recorded: the service
  # script, the Claude tab launcher, both update paths, provisioning and the
  # morning digest, run inside the image against a recording stand-in for the
  # CLI.
  docker run --rm --network none --platform "${platform}" \
    --volume "${PWD}/claude-code/app/test/image:/pins-src:ro" \
    --entrypoint bash "${tag}" /pins-src/behaviour-pins.sh
}

case "${command}" in
  build) build ;;
  check) check ;;
  *) echo "unknown command '${command}' (build|check)"; exit 2 ;;
esac
