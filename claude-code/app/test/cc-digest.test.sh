#!/usr/bin/env bash
# Tests for the morning digest (rootfs/usr/local/bin/cc-digest).
#
# Drives `cc-digest --once` with stubs for curl, agent-ask and the notifier:
#   1. the home snapshot reaches agent-ask on STDIN, with no arguments and no
#      Home Assistant credentials in its environment;
#   2. the answer is notified, titled with the agent's name;
#   3. an empty answer, a failed agent-ask or an undelivered briefing notifies
#      nothing and is logged; the call is time-limited;
#   4. without --once, a missing or malformed time disables the loop at once.
#
# Requires: bash and jq.
#
# Run, from app/:  npm run test:digest
set -o pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "${here}/../.." && pwd)"
script="${repo}/rootfs/usr/local/bin/cc-digest"

command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required"; exit 1; }
[ -x "${script}" ] || { echo "FAIL: ${script} is not executable"; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

cat > "${work}/curl" <<'STUB'
#!/usr/bin/env bash
cat <<'JSON'
[{"entity_id":"weather.home","state":"sunny","attributes":{"friendly_name":"Home weather","temperature":21}},
 {"entity_id":"light.porch","state":"on","attributes":{"friendly_name":"Porch light"}},
 {"entity_id":"binary_sensor.door","state":"on","attributes":{"device_class":"door","friendly_name":"Front door"}}]
JSON
STUB

cat > "${work}/agent" <<STUB
#!/usr/bin/env bash
cat > "${work}/agent.stdin"
printf '%s' "\$#" > "${work}/agent.argc"
leaked=''; for v in SUPERVISOR_TOKEN SUPERVISOR_API_TOKEN HA_TOKEN HASS_TOKEN; do [ -n "\${!v:-}" ] && leaked="\${leaked}\${v} "; done
printf '%s' "\${leaked}" > "${work}/agent.env"
[ -n "\${AGENT_ANSWER:-}" ] && printf '%s\n' "\${AGENT_ANSWER}"
echo "agent stderr: \${AGENT_ERR:-}" >&2
exit "\${AGENT_RC:-0}"
STUB

cat > "${work}/notify-broken" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB

cat > "${work}/timeout" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$1" >> "${work}/timeout.used"
shift
exec "\$@"
STUB

cat > "${work}/notify" <<STUB
#!/usr/bin/env bash
printf '%s|%s\n' "\$1" "\$2" >> "${work}/notified"
STUB
chmod +x "${work}/curl" "${work}/agent" "${work}/notify" "${work}/notify-broken" "${work}/timeout"

fails=0
ok()   { printf 'PASS  %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fails=$((fails + 1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want '$3', got '$2')"; fi; }

# $1 = answer, $2 = agent-ask exit status; NOTIFIER picks the notifier.
run() {
    rm -f "${work}"/agent.* "${work}/notified" "${work}/timeout.used" "${work}/stderr"
    CC_DIGEST_CURL="${work}/curl" CC_DIGEST_AGENT_CMD="${work}/agent" \
    CC_DIGEST_NOTIFY_CMD="${work}/${NOTIFIER:-notify}" CC_DIGEST_TIMEOUT_CMD="${work}/timeout" \
    SUPERVISOR_TOKEN="tok-supervisor" SUPERVISOR_API_TOKEN="tok-api" HA_TOKEN="tok-ha" HASS_TOKEN="tok-hass" \
    AGENT_ANSWER="$1" AGENT_RC="${2:-0}" AGENT_ERR="not logged in" \
        bash "${script}" --once >/dev/null 2>"${work}/stderr"
}
logged() { [[ "$(cat "${work}/stderr" 2>/dev/null)" == *"$1"* ]]; }

echo "cc-digest --once tests"

# --- 1. the snapshot reaches agent-ask the way its contract says ---------------
run "Good morning: sunny, the porch light is on."
seen="$(cat "${work}/agent.stdin" 2>/dev/null)"
if [[ "${seen}" == *"====HOME SNAPSHOT===="*"Home weather"*"Porch light"*"Front door"*"====END===="* ]]; then
    ok "the snapshot reaches agent-ask on stdin"
else
    bad "the snapshot is not on agent-ask's stdin: ${seen:0:200}"
fi
check "agent-ask gets no arguments" "$(cat "${work}/agent.argc" 2>/dev/null)" "0"
check "no Home Assistant credentials reach agent-ask's environment" "$(cat "${work}/agent.env" 2>/dev/null)" ""
if [[ "${seen}" != *"tok-"* ]]; then ok "and none is pasted into the prompt"; else bad "a token is in the prompt"; fi

# --- 2. the answer is notified, titled with the agent's name -----------------------
# No add-on console here, so no branding.json: the fallback name is used.
check "the briefing is notified with the agent's name in the title" \
      "$(cat "${work}/notified" 2>/dev/null)" "Good morning: sunny, the porch light is on.|Agent · Morning briefing"

check "agent-ask is limited to 300 s" "$(cat "${work}/timeout.used" 2>/dev/null)" "300"
if [ -s "${work}/stderr" ]; then bad "a delivered briefing logged: $(cat "${work}/stderr")"; else ok "a delivered briefing logs nothing"; fi

# --- 3. no answer, a failure or no delivery: nothing notified, and logged ----------
run ""
if [ -e "${work}/agent.stdin" ]; then ok "agent-ask was asked"; else bad "agent-ask was never run"; fi
if [ -e "${work}/notified" ]; then bad "an empty answer was notified"; else ok "an empty answer notifies nothing"; fi
if logged "[cc-digest] the briefing produced nothing (exit 0): agent stderr: not logged in"; then
    ok "and is logged with agent-ask's stderr"
else
    bad "an empty answer is not logged: $(cat "${work}/stderr")"
fi

run "Partial answer" 1
if [ -e "${work}/notified" ]; then bad "a failed agent-ask was notified"; else ok "a failed agent-ask notifies nothing, even with output"; fi
if logged "[cc-digest] the briefing produced nothing (exit 1): agent stderr: not logged in"; then
    ok "and is logged with its exit status"
else
    bad "a failed agent-ask is not logged: $(cat "${work}/stderr")"
fi

NOTIFIER=notify-broken run "Good morning."
if logged "[cc-digest] could not deliver the briefing"; then
    ok "an undelivered briefing is logged"
else
    bad "an undelivered briefing is not logged: $(cat "${work}/stderr")"
fi

# --- 4. a missing or malformed time disables the loop at once ----------------------
# Bounded without `timeout`, which not every development machine has.
ends_within() {  # $1 = seconds; the rest = the command. Prints its status, or "running".
    local limit="$1" pid i
    shift
    "$@" >/dev/null 2>&1 &
    pid=$!
    for (( i = 0; i < limit * 10; i++ )); do
        if ! kill -0 "${pid}" 2>/dev/null; then wait "${pid}"; printf '%s' "$?"; return; fi
        sleep 0.1
    done
    kill -9 "${pid}" 2>/dev/null
    wait "${pid}" 2>/dev/null
    printf 'running'
}
for t in "" "7:00" "24:00" "07:60" "07:00x"; do
    check "time '${t}' disables the digest at once" \
          "$(CLAUDE_DIGEST_TIME="${t}" CC_DIGEST_AGENT_CMD="${work}/agent" ends_within 5 bash "${script}")" "0"
done
check "and a valid time keeps it running" \
      "$(CLAUDE_DIGEST_TIME="07:00" CC_DIGEST_AGENT_CMD="${work}/agent" ends_within 1 bash "${script}")" "running"

printf '\n%s\n' "$([ "${fails}" -eq 0 ] && echo 'all checks passed' || echo "${fails} check(s) failed")"
exit $(( fails > 0 ))
