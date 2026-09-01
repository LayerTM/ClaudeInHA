#!/usr/bin/env bash
# Tests for config_list (rootfs/usr/local/lib/addon-config.sh) — the reader every
# list-type add-on option goes through.
#
# Regression guard for ClaudeInHA#51: the previous reader, `bashio::config`, ends
# in `printf "%s"` (no trailing newline), and `while IFS= read -r` silently drops
# a final unterminated line. A ONE-entry list therefore ran the loop body zero
# times — no output, not even the malformed-entry warning — and a two-entry list
# lost its last entry. The same defect silently truncated init_commands and
# extra_args.
#
# The last case asserts the *shape* that made the bug possible: the reader's
# output must be newline-terminated. Without it, a future "simplification" back
# to printf-style output would pass every count above and reintroduce the bug.
#
# Requires: bash + jq. No Home Assistant, no Supervisor, no container.
#
# Run:  bash claude-code/app/test/config-list.test.sh
#   or, from claude-code/app:  npm run test:config
set -o pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "${here}/../.." && pwd)"           # claude-code/
lib="${repo}/rootfs/usr/local/lib/addon-config.sh"

command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not installed"; exit 0; }
[ -f "${lib}" ] || { echo "FAIL: ${lib} is missing"; exit 1; }
# shellcheck source=../../rootfs/usr/local/lib/addon-config.sh
source "${lib}"

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
opts="${work}/options.json"

fails=0
pass() { printf '  ok  - %s\n' "$1"; }
fail() { printf '  NOT ok - %s (got %s, want %s)\n' "$1" "$2" "$3"; fails=$((fails + 1)); }
check() { [ "$2" = "$3" ] && pass "$1" || fail "$1" "$2" "$3"; }

# Entries actually delivered to a `while IFS= read -r` loop — the exact shape
# every call site uses, and the one the old reader got wrong.
delivered() {
    printf '%s' "$1" > "${opts}"
    local n=0
    while IFS= read -r _entry; do
        [ -n "${_entry}" ] || continue
        n=$((n + 1))
    done < <(config_list "$2" "${opts}")
    printf '%s' "${n}"
}

echo "config_list"

check "one entry reaches the loop (the #51 case)" \
    "$(delivered '{"environment_vars":["HA_NOTIFY_SERVICE=notify.mobile_app_x"]}' environment_vars)" 1
check "two entries — the last is not dropped" \
    "$(delivered '{"init_commands":["echo one","echo two"]}' init_commands)" 2
check "three entries" \
    "$(delivered '{"extra_args":["--a","--b","--c"]}' extra_args)" 3
check "empty list yields nothing" \
    "$(delivered '{"environment_vars":[]}' environment_vars)" 0
check "absent key yields nothing" \
    "$(delivered '{"model":"opus"}' environment_vars)" 0
check "unparseable options.json yields nothing, not an error" \
    "$(delivered 'not json at all' environment_vars)" 0

printf '%s' '{"environment_vars":["URL=https://h:8123/api?a=b&c=d"]}' > "${opts}"
check "a value containing '=' and '&' survives intact" \
    "$(config_list environment_vars "${opts}")" 'URL=https://h:8123/api?a=b&c=d'

printf '%s' '{"environment_vars":["MSG=hello world \"quoted\""]}' > "${opts}"
check "a value with spaces and quotes survives intact" \
    "$(config_list environment_vars "${opts}")" 'MSG=hello world "quoted"'

# The shape assertion — see the header. `$( )` strips trailing newlines, so read
# the raw bytes instead.
printf '%s' '{"environment_vars":["ONLY=one"]}' > "${opts}"
config_list environment_vars "${opts}" > "${work}/raw"
check "output is newline-terminated (what the old reader lost)" \
    "$(tail -c1 "${work}/raw" | od -An -c | tr -d ' \n')" '\n'

check "a missing options file yields nothing, not an error" \
    "$(config_list environment_vars "${work}/does-not-exist.json")" ''

# Every list-type option in config.yaml must be read by config_list, not by
# bashio::config — the bug was three call sites, and a fourth is one edit away.
# Every list-type option in config.yaml must be read by config_list, not by
# bashio::config — the bug was three call sites, and a fourth is one edit away.
leaked="$(python3 - "${repo}" <<'PYSCAN'
import pathlib, re, sys

repo = pathlib.Path(sys.argv[1])
schema = (repo / "config.yaml").read_text().split("schema:")[1]

lists, key = [], None
for line in schema.splitlines():
    match = re.match(r"^  (\w+):", line)
    if match:
        key = match.group(1)
    elif re.match(r"^    - ", line) and key:
        lists.append(key)
        key = None

sources = [
    path.read_text(errors="ignore")
    for path in (repo / "rootfs").rglob("*")
    if path.is_file()
]
print(" ".join(k for k in lists if any(f"bashio::config '{k}'" in src for src in sources)))
PYSCAN
)"
check "no list option is still read via bashio::config" "${leaked}" ""

echo
if [ "${fails}" -eq 0 ]; then
    echo "All config_list tests passed."
else
    echo "${fails} config_list test(s) failed."
fi
exit "${fails}"
