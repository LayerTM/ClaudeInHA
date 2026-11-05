#!/usr/bin/env bash
# Tests for the settings.json writers (rootfs/usr/local/lib/addon-settings-file.sh
# and the three callers: status line, safety hooks, transcript sweep).
#
# A power cut can leave /data/home/.claude/settings.json zero bytes long (the
# rename reached the disk, the data did not). jq reads an empty file as "no
# input", prints nothing and exits 0, so every writer used to turn that into
# `failed` / a start-up warning and the file stayed empty for good: no status
# line, none of the console's safety hooks (backup before a risky change, audit
# log, needs-input notification), and Claude's own transcript sweep left at its
# default. An empty file holds no user content, so it is repaired; a non-empty
# file that is not JSON may hold the user's work and is never touched.
#
# Requires: bash + jq. A missing dependency FAILS rather than skipping.
#
# Run:  bash claude-code/app/test/settings-file.test.sh
set -o pipefail

here="$(cd "$(dirname "$0")" && pwd)"
addon="$(cd "${here}/../.." && pwd)"
libdir="${addon}/rootfs/usr/local/lib"

command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required by this test and by the library"; exit 1; }
for f in addon-settings-file.sh addon-hooks.sh addon-statusline.sh engine-hooks.sh; do
    [ -f "${libdir}/${f}" ] || { echo "FAIL: ${libdir}/${f} is missing"; exit 1; }
done

# The libraries read these; the values are the ones the add-on's run script sets.
CC_HOOK_BACKUP_MATCHER='Edit|Write'
CC_HOOK_BACKUP_CMD=/usr/local/bin/cc-hook-backup
CC_HOOK_NOTIFY_CMD=/usr/local/bin/cc-hook-notify
# shellcheck source=../../rootfs/usr/local/lib/addon-settings-file.sh
source "${libdir}/addon-settings-file.sh"
# shellcheck source=../../rootfs/usr/local/lib/addon-hooks.sh
source "${libdir}/addon-hooks.sh"
# shellcheck source=../../rootfs/usr/local/lib/addon-statusline.sh
source "${libdir}/addon-statusline.sh"
# The engine hooks need bashio only when a function runs; the log calls are stubbed.
bashio::log.warning() { LOGGED="${LOGGED:-}$*"$'\n'; }
bashio::log.info() { :; }
# engine-hooks.sh sources its libraries by their installed path, so only the
# function under test is taken from it.
eval "$(sed -n '/^engine_transcript_retention() {/,/^}/p' "${libdir}/engine-hooks.sh")"

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
sf="${work}/settings.json"

fails=0
ran=0
pass() { ran=$((ran + 1)); printf '  ok  - %s\n' "$1"; }
fail() { ran=$((ran + 1)); printf '  NOT ok - %s (got %s, want %s)\n' "$1" "$2" "$3"; fails=$((fails + 1)); }
check() { [ "$2" = "$3" ] && pass "$1" || fail "$1" "$2" "$3"; }
leftovers() { find "${work}" -mindepth 1 ! -name settings.json | wc -l | tr -d ' '; }

empty_cases=(
    "zero bytes|"
    "only whitespace|   "$'\n\t'"  "
)

for case in "${empty_cases[@]}"; do
    label="${case%%|*}"
    content="${case#*|}"
    echo "settings.json with ${label}"

    printf '%s' "${content}" > "${sf}"
    check "ready: repaired, exit 0" "$(settings_file_ready "${sf}" >/dev/null 2>&1; echo $?)" 0
    check "ready: the file is now an empty JSON object" "$(jq -c '.' "${sf}" 2>/dev/null)" '{}'

    printf '%s' "${content}" > "${sf}"
    check "status line is seeded" "$(statusline_seed_or_migrate "${sf}")" seeded
    check "  and it is there" "$(jq -r '.statusLine.command' "${sf}")" "${CC_STATUSLINE_CMD}"

    printf '%s' "${content}" > "${sf}"
    check "safety hooks are seeded" "$(hooks_seed_or_migrate "${sf}")" seeded
    check "  all four events" "$(jq -c '.hooks | keys' "${sf}")" '["Notification","PostToolUse","PostToolUseFailure","PreToolUse"]'

    printf '%s' "${content}" > "${sf}"
    LOGGED=""
    ENGINE_SETTINGS_FILE="${sf}" engine_transcript_retention >/dev/null
    check "transcript sweep is pushed out" "$(jq -r '.cleanupPeriodDays // empty' "${sf}" 2>/dev/null)" 3650
    check "  without a warning" "${LOGGED}" ""
    check "nothing is left beside the file" "$(leftovers)" 0
done

echo "settings.json that does not exist"
rm -f "${sf}"
check "status line is seeded" "$(statusline_seed_or_migrate "${sf}")" seeded
rm -f "${sf}"
check "safety hooks are seeded" "$(hooks_seed_or_migrate "${sf}")" seeded

echo "settings.json with the user's own content"
user='{"model":"opus","env":{"A":"1"},"permissions":{"allow":["Bash(ls)"]}}'
printf '%s' "${user}" > "${sf}"
check "status line is seeded" "$(statusline_seed_or_migrate "${sf}")" seeded
check "safety hooks are seeded" "$(hooks_seed_or_migrate "${sf}")" seeded
ENGINE_SETTINGS_FILE="${sf}" engine_transcript_retention >/dev/null
check "the user's keys survive" "$(jq -c '{model, env, permissions}' "${sf}")" "$(printf '%s' "${user}" | jq -c '.')"
check "nothing is left beside the file" "$(leftovers)" 0

echo "settings.json that is not JSON but not empty"
for junk in '{"model":' 'model: opus' '[1,2'; do
    printf '%s' "${junk}" > "${sf}"
    check "ready refuses (${junk})" "$(settings_file_ready "${sf}" >/dev/null 2>&1; echo $?)" 1
    check "  file is byte-identical" "$(cat "${sf}")" "${junk}"
    check "  status line reports failed" "$(statusline_seed_or_migrate "${sf}")" failed
    check "  hooks report failed" "$(hooks_seed_or_migrate "${sf}")" failed
    LOGGED=""
    ENGINE_SETTINGS_FILE="${sf}" engine_transcript_retention >/dev/null
    check "  sweep warns" "$([ -n "${LOGGED}" ] && echo warned)" warned
    check "  file is still byte-identical" "$(cat "${sf}")" "${junk}"
    check "  nothing is left beside the file" "$(leftovers)" 0
done

echo "a JSON value that is not an object"
printf '[1,2]' > "${sf}"
check "ready refuses an array" "$(settings_file_ready "${sf}" >/dev/null 2>&1; echo $?)" 1
check "  file untouched" "$(cat "${sf}")" '[1,2]'

echo "settings_file_edit never replaces the file with nothing"
printf '%s' "${user}" > "${sf}"
check "a filter with no output is refused" "$(settings_file_edit "${sf}" 'empty' >/dev/null 2>&1; echo $?)" 1
check "  file untouched" "$(jq -c '.' "${sf}")" "$(printf '%s' "${user}" | jq -c '.')"
check "a filter that errors is refused" "$(settings_file_edit "${sf}" '.a.b.c |= error("x")' >/dev/null 2>&1; echo $?)" 1
check "  file untouched" "$(jq -c '.' "${sf}")" "$(printf '%s' "${user}" | jq -c '.')"
check "a filter yielding a non-object is refused" "$(settings_file_edit "${sf}" '[.]' >/dev/null 2>&1; echo $?)" 1
check "  file untouched" "$(jq -c '.' "${sf}")" "$(printf '%s' "${user}" | jq -c '.')"
check "a good edit lands" "$(settings_file_edit "${sf}" '.x = 1' >/dev/null 2>&1; jq -c '.x' "${sf}")" 1
check "nothing is left beside the file" "$(leftovers)" 0

echo "the write is a same-directory rename"
# A temp file in /tmp is another filesystem: mv is then copy + unlink, and a cut
# in the middle leaves a short file. The temp name must live beside the target.
case "$(cat "${libdir}/addon-settings-file.sh")" in
    *'mktemp "${file}'*) pass "the temp file is created beside the target" ;;
    *) fail "the temp file is created beside the target" "no mktemp beside it" "mktemp \"\${file}…\"" ;;
esac
for f in addon-hooks.sh addon-statusline.sh engine-hooks.sh; do
    case "$(cat "${libdir}/${f}")" in
        *'mktemp)'* | *'mktemp)"'*) fail "${f} writes settings.json through the library only" "bare mktemp" "none" ;;
        *) pass "${f} writes settings.json through the library only" ;;
    esac
done

# A floor on the assertion count, so an edit that guts the file cannot report
# success by running almost nothing.
if [ "${ran}" -lt 55 ]; then
    echo "FAIL: only ${ran} settings-file assertions ran — expected at least 55"
    exit 1
fi
if [ "${fails}" -eq 0 ]; then
    echo "PASS: all ${ran} settings-file checks passed"
    exit 0
fi
echo "FAIL: ${fails} of ${ran} settings-file check(s) failed"
exit 1
