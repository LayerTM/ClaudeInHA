#!/usr/bin/env bash
# Tests for statusline_seed_or_migrate (rootfs/usr/local/lib/addon-statusline.sh).
#
# Claude Code re-runs the status line only on events, and a terminal resize is
# not one of them. Claude starts with the add-on in a tmux session no browser has
# attached to, so its first status line is drawn for 80 columns and stays cut off
# until the first event. The fix is a refresh interval on the statusLine — and
# because /data persists across updates, it only helps existing installations if
# the migration adds it there. So the migration is asserted in both directions:
# our own entries gain the interval, and anything the user wrote is left alone.
#
# Requires: bash + jq. A missing dependency FAILS rather than skipping.
#
# Run:  bash claude-code/app/test/cc-statusline.test.sh
#   or, from claude-code/app:  npm run test:statusline
set -o pipefail

here="$(cd "$(dirname "$0")" && pwd)"
addon="$(cd "${here}/../.." && pwd)"                 # claude-code/
run="${addon}/rootfs/etc/s6-overlay/s6-rc.d/claude-code/run"
lib="${addon}/rootfs/usr/local/lib/addon-statusline.sh"

command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required by this test and by the library"; exit 1; }
[ -f "${run}" ] || { echo "FAIL: ${run} is missing"; exit 1; }
[ -f "${lib}" ] || { echo "FAIL: ${lib} is missing"; exit 1; }
# shellcheck source=../../rootfs/usr/local/lib/addon-statusline.sh
source "${lib}"

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
settings="${work}/settings.json"

fails=0
ran=0
pass() { ran=$((ran + 1)); printf '  ok  - %s\n' "$1"; }
fail() { ran=$((ran + 1)); printf '  NOT ok - %s (got %s, want %s)\n' "$1" "$2" "$3"; fails=$((fails + 1)); }
check() { [ "$2" = "$3" ] && pass "$1" || fail "$1" "$2" "$3"; }

sl() { jq -c '.statusLine' "${settings}"; }
want_full="{\"type\":\"command\",\"command\":\"${CC_STATUSLINE_CMD}\",\"padding\":0,\"refreshInterval\":${CC_STATUSLINE_REFRESH}}"

echo "the service script uses the library"
case "$(cat "${run}")" in
    *"statusline_seed_or_migrate"*) pass "the service script calls statusline_seed_or_migrate" ;;
    *) fail "the service script calls statusline_seed_or_migrate" "absent" "present" ;;
esac
case "$(cat "${run}")" in
    *"source /usr/local/lib/addon-statusline.sh"*) pass "and sources the library that defines it" ;;
    *) fail "and sources the library that defines it" "absent" "present" ;;
esac
case "$(cat "${run}")" in
    *'.statusLine = {'*) fail "the old inline seed is gone" "present" "absent" ;;
    *) pass "the old inline seed is gone" ;;
esac

echo "the interval itself"
case "${CC_STATUSLINE_REFRESH}" in
    '' | *[!0-9]*) fail "the interval is a positive integer" "${CC_STATUSLINE_REFRESH}" "digits" ;;
    *) [ "${CC_STATUSLINE_REFRESH}" -ge 1 ] && pass "the interval is a positive integer" \
                                           || fail "the interval is a positive integer" "${CC_STATUSLINE_REFRESH}" ">= 1" ;;
esac

echo "fresh installs"
rm -f "${settings}"
check "a missing settings file is seeded" "$(statusline_seed_or_migrate "${settings}")" seeded
check "with the wrapper and the interval" "$(sl)" "${want_full}"
check "seeding twice changes nothing" "$(statusline_seed_or_migrate "${settings}")" unchanged
check "and leaves the entry as it was" "$(sl)" "${want_full}"

printf '{"model":"opus","env":{"A":"1"}}\n' > "${settings}"
check "settings without a statusLine are seeded" "$(statusline_seed_or_migrate "${settings}")" seeded
check "and the other keys are kept" "$(jq -c '{model, env}' "${settings}")" '{"model":"opus","env":{"A":"1"}}'

printf '{"statusLine":{"type":"command","command":""}}\n' > "${settings}"
check "an entry with an empty command is seeded" "$(statusline_seed_or_migrate "${settings}")" seeded
check "with the full entry" "$(sl)" "${want_full}"

echo "existing installations — the case the fix exists for"
# 1.47–1.56: the wrapper, no interval. Every current user is here.
printf '{"statusLine":{"type":"command","command":"%s","padding":0},"model":"opus"}\n' "${CC_STATUSLINE_CMD}" > "${settings}"
check "the wrapper without an interval is migrated" "$(statusline_seed_or_migrate "${settings}")" migrated
check "and gains the interval" "$(jq -r '.statusLine.refreshInterval' "${settings}")" "${CC_STATUSLINE_REFRESH}"
check "keeping command and padding" "$(jq -c '.statusLine | {command, padding}' "${settings}")" \
    "{\"command\":\"${CC_STATUSLINE_CMD}\",\"padding\":0}"
check "and the other keys" "$(jq -r '.model' "${settings}")" opus
check "migrating twice changes nothing" "$(statusline_seed_or_migrate "${settings}")" unchanged

# Our own padding choice on the wrapper is not reset by the migration.
printf '{"statusLine":{"type":"command","command":"%s","padding":2}}\n' "${CC_STATUSLINE_CMD}" > "${settings}"
statusline_seed_or_migrate "${settings}" >/dev/null
check "a changed padding on the wrapper is kept" "$(jq -r '.statusLine.padding' "${settings}")" 2

# The earlier defaults move to the full current entry.
for old in /usr/local/bin/cc-statusline /usr/local/bin/ccstatusline; do
    printf '{"statusLine":{"type":"command","command":"%s"}}\n' "${old}" > "${settings}"
    check "the old default ${old} is migrated" "$(statusline_seed_or_migrate "${settings}")" migrated
    check "to the full current entry" "$(sl)" "${want_full}"
done

echo "the user's own settings"
printf '{"statusLine":{"type":"command","command":"%s","padding":0,"refreshInterval":5}}\n' "${CC_STATUSLINE_CMD}" > "${settings}"
check "a user-set interval is left alone" "$(statusline_seed_or_migrate "${settings}")" unchanged
check "and keeps the user's value" "$(jq -r '.statusLine.refreshInterval' "${settings}")" 5

printf '{"statusLine":{"type":"command","command":"/config/my-line.sh"}}\n' > "${settings}"
check "a user's own command is left alone" "$(statusline_seed_or_migrate "${settings}")" unchanged
check "and gets no interval it did not ask for" "$(jq -r '.statusLine | has("refreshInterval")' "${settings}")" false
check "and keeps its command" "$(jq -r '.statusLine.command' "${settings}")" /config/my-line.sh

printf '{"statusLine":"something else"}\n' > "${settings}"
check "a statusLine that is not an object is left alone" "$(statusline_seed_or_migrate "${settings}")" unchanged
check "and is not rewritten" "$(jq -r '.statusLine' "${settings}")" "something else"

echo "a file that cannot be read is a failure, never 'unchanged'"
printf '{not json\n' > "${settings}"
check "unparseable settings report failed" "$(statusline_seed_or_migrate "${settings}")" failed
check "and are not overwritten" "$(cat "${settings}")" '{not json'

echo
# A floor on the assertion count, so an edit that guts the file cannot report
# success by running almost nothing.
if [ "${ran}" -lt 30 ]; then
    echo "FAIL: only ${ran} statusline assertions ran — expected at least 30"
    exit 1
fi
if [ "${fails}" -eq 0 ]; then
    echo "PASS: all ${ran} statusline checks passed"
    exit 0
fi
echo "FAIL: ${fails} of ${ran} statusline check(s) failed"
exit 1
