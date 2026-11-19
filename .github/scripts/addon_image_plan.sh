#!/usr/bin/env bash
# Print, for a GitHub output, whether this run publishes a release candidate
# (`publish=true|false`) and, when it does, the image (`image=`). A pull
# request is compared with the version its base offers, so the base's
# config.yaml is read from the base commit.
#
# Env: EVENT, TITLE, HEAD_REPO, REPO, BASE_SHA, CANARY (see addon_image.py plan).
set -euo pipefail

if [ "${EVENT:-}" = pull_request ]; then
  if ! git cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null; then
    git fetch --no-tags --depth=1 origin "${BASE_SHA}"
  fi
  export BASE_CONFIG="${RUNNER_TEMP}/base-config.yaml"
  if ! git show "${BASE_SHA}:claude-code/config.yaml" > "${BASE_CONFIG}"; then rm -f "${BASE_CONFIG}"; fi
fi
python3 .github/scripts/addon_image.py plan
