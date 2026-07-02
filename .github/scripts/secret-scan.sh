#!/usr/bin/env bash
# Fail if any tracked file contains a secret, credential, or personal datum.
# Dependency-free (uses git grep); scans only git-tracked files. Enforces the
# repo's hard rule: nothing personal, no tokens/keys/secrets, no local paths or
# private IPs.
set -uo pipefail

# High-signal patterns (extended regex). Add cautiously — false positives block CI.
patterns=(
  'sk-ant-[A-Za-z0-9_-]{16,}'                  # Anthropic API key
  'ghp_[A-Za-z0-9]{30,}'                        # GitHub PAT (classic)
  'github_pat_[A-Za-z0-9_]{30,}'                # GitHub PAT (fine-grained)
  'xox[baprs]-[A-Za-z0-9-]{10,}'                # Slack token
  'AKIA[0-9A-Z]{16}'                            # AWS access key id
  'BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY'  # private key blocks
  '/Users/[a-z]'                                # personal macOS paths
  '[A-Za-z0-9._%+-]+@gmail\.com'                # personal email
  '192\.168\.[0-9]'                             # private LAN IPs
  '10\.0\.0\.[0-9]'
)
pattern="$(IFS='|'; echo "${patterns[*]}")"

# git grep exits 0 when it finds matches; scan tracked files, excluding images
# and this scanner (which necessarily contains the patterns).
if hits="$(git grep -InE "${pattern}" -- \
      ':(exclude,glob)**/*.png' ':(exclude,glob)**/*.jpg' \
      ':(exclude,glob)**/*.jpeg' ':(exclude,glob)**/*.gif' \
      ':(exclude,glob)**/*.ico' ':(exclude,glob)**/*.webp' \
      ':(exclude).github/scripts/secret-scan.sh')"; then
  echo "::error::Potential secret or personal data found in tracked files:"
  echo "${hits}"
  exit 1
fi

echo "secret-scan: clean"
