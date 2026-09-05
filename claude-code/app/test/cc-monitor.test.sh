#!/usr/bin/env bash
# Tests for the proactive monitoring loop (rootfs/usr/local/bin/cc-monitor).
#
# Drives `cc-monitor --once` with stubs for the log source, the config check, the
# analysing command and the notifier, and asserts the cases where the loop used
# to go quiet:
#   1. a healthy run notifies nothing;
#   2. a finding is notified;
#   3. an unreadable log source is REPORTED, not treated as an empty log;
#   4. an analysis that produces nothing is REPORTED, not treated as healthy;
#   5. neither of those repeats on the next cycle, and the recovery clears it;
#   6. the prompt actually reaches the analysing command;
#   7. the model runs with no tools and no Home Assistant credentials;
#   8. every external call is time-limited;
#   9. a notifier that cannot deliver does not silence the warning for good.
#
# Case 6 is the one with history: passed as a positional argument the prompt is
# consumed by --allowed-tools, which takes a list, and the command exits with no
# input. Nothing downstream could tell that from a healthy, quiet instance.
#
# Requires: bash, and nothing else. The assertions use bash's own pattern
# matching rather than an external matcher on purpose: a missing tool makes
# `if <tool> ...` false, and a check written as if/else then reports PASS from
# its else branch — passing because the instrument is dead.
#
# Run:  bash claude-code/app/test/cc-monitor.test.sh
#   or, from claude-code/app:  npm run test:monitor   (see package.json)
set -o pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "${here}/../.." && pwd)"           # claude-code/
script="${repo}/rootfs/usr/local/bin/cc-monitor"

[ -x "${script}" ] || { echo "FAIL: ${script} is not executable"; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

notify_out="${work}/notified.txt"
claude_in="${work}/claude-stdin.txt"
claude_argv="${work}/claude-argv.txt"
claude_env="${work}/claude-env.txt"
timeout_used="${work}/timeout-used.txt"
: > "${notify_out}"
: > "${timeout_used}"

# Records every notification so the assertions can read them back.
cat > "${work}/notify" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$1" >> "${notify_out}"
STUB

# Records what the analysing command actually received on stdin, then answers
# with whatever the case asked for via CLAUDE_ANSWER (empty answer + a non-zero
# exit reproduces the failure this script used to swallow).
cat > "${work}/claude" <<STUB
#!/usr/bin/env bash
cat > "${claude_in}"
printf '%s\n' "\$*" > "${claude_argv}"
leaked=''; for v in SUPERVISOR_TOKEN SUPERVISOR_API_TOKEN HA_TOKEN HASS_TOKEN; do [ -n "\${!v:-}" ] && leaked="\${leaked}\${v} "; done; printf '%s' "\${leaked}" > "${claude_env}"
[ -n "\${CLAUDE_ANSWER:-}" ] && printf '%s\n' "\${CLAUDE_ANSWER}"
exit "\${CLAUDE_RC:-0}"
STUB

# A notifier that cannot deliver — missing, or failing, or the service is down.
cat > "${work}/notify-broken" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB

# A config check that produces nothing, i.e. is missing or broken. A NON-ZERO
# exit is not this case: that is what an invalid configuration looks like, and it
# is a finding rather than a fault.
cat > "${work}/check-broken" <<'STUB'
#!/usr/bin/env bash
exit 127
STUB

# Stands in for `timeout`: records that it was used, then runs the rest.
cat > "${work}/timeout" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$1" >> "${timeout_used}"
shift
exec "\$@"
STUB

cat > "${work}/check" <<'STUB'
#!/usr/bin/env bash
echo "Configuration valid"
STUB

# Stubs for curl, NOT for the whole fetch: the status handling is the half that
# was missing, so the test has to go through it. Each prints a body followed by
# the status line curl's -w writes, exactly as the real call does.
#
# The healthy body carries journald colour codes, so the stripping is covered
# rather than assumed.
cat > "${work}/goodlog" <<'STUB'
#!/usr/bin/env bash
printf '\033[32mWARNING\033[0m (MainThread) [homeassistant.components.foo] something\n200'
STUB

# What a removed endpoint looks like: a short body and an exit of 0. Taken
# without reading the status, this is text that reads like a quiet, healthy log.
cat > "${work}/badlog" <<'STUB'
#!/usr/bin/env bash
printf '404: Not Found\n404'
STUB

chmod +x "${work}"/notify "${work}"/notify-broken "${work}"/claude "${work}"/check \
         "${work}"/check-broken "${work}"/goodlog "${work}"/badlog "${work}"/timeout

fails=0
ok()   { printf 'PASS  %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fails=$((fails + 1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want '$3', got '$2')"; fi; }

# $1 = log stub, $2 = CLAUDE_ANSWER, $3 = CLAUDE_RC ; prints the exit status
run() {
    CC_MONITOR_DATA_DIR="${work}/data" \
    CC_MONITOR_NOTIFY_CMD="${work}/${NOTIFIER:-notify}" \
    CC_MONITOR_CHECK_CMD="${work}/${CHECKER:-check}" \
    CC_MONITOR_CURL="${work}/$1" \
    CC_MONITOR_CLAUDE_CMD="${work}/claude" \
    CC_MONITOR_TIMEOUT_CMD="${work}/timeout" \
    SUPERVISOR_TOKEN="tok-supervisor" HA_TOKEN="tok-ha" \
    CLAUDE_ANSWER="$2" CLAUDE_RC="${3:-0}" \
        bash "${script}" --once >/dev/null 2>&1
    printf '%s' "$?"
}

markers() { ls "${work}/data" 2>/dev/null | wc -l | tr -d ' '; }

notifications() { wc -l < "${notify_out}" | tr -d ' '; }

# --- 1. healthy: nothing is notified -----------------------------------------
rc="$(run goodlog OK)"
check "a healthy run exits 0"                 "${rc}" "0"
check "a healthy run notifies nothing"        "$(notifications)" "0"

# --- 6. the prompt reaches the command, on stdin ------------------------------
seen="$(cat "${claude_in}")"
if [[ "${seen}" == *"ERROR LOG"* && "${seen}" == *"something"* ]]; then
    ok "the prompt and the log reach the analysing command"
else
    bad "the prompt never reached the analysing command (stdin was: ${seen:0:80})"
fi

# The colour codes journald emits are noise to a reader and to the model.
if [[ "${seen}" == *$'\033'* ]]; then
    bad "terminal colour codes were passed through into the prompt"
else
    ok "colour codes are stripped out of the log"
fi

# --- 2. a finding is notified -------------------------------------------------
rc="$(run goodlog 'Two integrations failed to set up.')"
check "a finding exits 0"                     "${rc}" "0"
check "a finding is notified"                 "$(notifications)" "1"

# --- 3. an unreadable log source is reported ----------------------------------
: > "${notify_out}"
rc="$(run badlog OK)"
check "an unreadable log source exits non-zero" "${rc}" "1"
check "an unreadable log source is notified"    "$(notifications)" "1"
said="$(cat "${notify_out}")"
if [[ "${said}" == *"cannot read"* ]]; then
    ok "and the notification says the check is not running"
else
    bad "the notification does not say the check stopped: ${said}"
fi

# --- 5a. it does not repeat on the next cycle ---------------------------------
run badlog OK >/dev/null
check "a lasting log failure notifies once, not every cycle" "$(notifications)" "1"

# --- 5b. recovery clears it, and it can fire again -----------------------------
run goodlog OK >/dev/null
check "recovery notifies nothing"             "$(notifications)" "1"
run badlog OK >/dev/null
check "a failure after a recovery is notified again" "$(notifications)" "2"

# --- 4. an analysis that produces nothing is reported --------------------------
: > "${notify_out}"
rm -rf "${work}/data"
rc="$(run goodlog '' 1)"
check "a silent analysis exits non-zero"      "${rc}" "1"
check "a silent analysis is notified"         "$(notifications)" "1"
said="$(cat "${notify_out}")"
if [[ "${said}" == *"not producing an answer"* ]]; then
    ok "and the notification says nothing is being reported"
else
    bad "the notification does not describe the silence: ${said}"
fi

# An empty answer with a ZERO exit is the same defect wearing a different hat.
: > "${notify_out}"
rm -rf "${work}/data"
rc="$(run goodlog '' 0)"
check "an empty answer with exit 0 is also reported" "$(notifications)" "1"
check "and it exits non-zero"                 "${rc}" "1"
said="$(cat "${notify_out}")"
if [[ "${said}" == *"not producing an answer"* ]]; then
    ok "and it says the check is broken rather than pushing the emptiness on"
else
    bad "an empty answer was passed on as a finding: ${said}"
fi

# --- 7. the analysing command runs with no tools and no credentials -----------
# The script's whole safety argument is that log data reaching the model cannot
# act: no tools, no permission bypass, no Home Assistant token in the child's
# environment. Nothing watched that, so removing either would have been silent.
: > "${notify_out}"
rm -rf "${work}/data"
: > "${timeout_used}"          # count this run only, not every run before it
run goodlog OK >/dev/null
argv="$(cat "${claude_argv}")"
if [[ "${argv}" == *"--allowed-tools"* && "${argv}" != *"dangerously"* ]]; then
    ok "the model is run with no tools and no permission bypass"
else
    bad "the tool restrictions are gone from the command line: ${argv}"
fi
# Bash builtins, not an external matcher with a GNU-only alternation: on a BSD
# sed that pattern matches nothing, so the check would pass everywhere by being
# dead. Proven by control below — it must SEE the variables when they are there.
check "no Home Assistant credentials reach the model" "$(cat "${claude_env}")" ""

# The control that makes the line above mean anything: with the stripping removed
# the same recorder must report the leak. Without this, an empty result and a
# broken recorder are the same result.
CC_MONITOR_DATA_DIR="${work}/data" CC_MONITOR_NOTIFY_CMD="${work}/notify" \
CC_MONITOR_CHECK_CMD="${work}/check" CC_MONITOR_CURL="${work}/goodlog" \
SUPERVISOR_TOKEN="tok" HA_TOKEN="tok" CLAUDE_ANSWER=OK \
    bash -c 'cat > /dev/null; . /dev/stdin' </dev/null 2>/dev/null || true
SUPERVISOR_TOKEN="tok" HA_TOKEN="tok" "${work}/claude" </dev/null >/dev/null 2>&1
if [ -n "$(cat "${claude_env}")" ]; then
    ok "and the check that says so can actually see a leak when there is one"
else
    bad "the credential check cannot see anything — it would pass no matter what"
fi

# --- 8. the calls are time-limited -------------------------------------------
# One stuck call would stop the loop, and a loop that is not looping notifies
# exactly as often as a healthy one: never.
check "the log fetch and the analysis are both bounded" "$(wc -l < "${timeout_used}" | tr -d ' ')" "2"

# --- 9. a notifier that cannot deliver does not silence the warning -----------
# The condition marker must be written only after the message is actually out.
# Written first, one failed delivery would suppress that warning forever.
: > "${notify_out}"
rm -rf "${work}/data"
NOTIFIER=notify-broken run badlog OK >/dev/null
check "a failed delivery leaves nothing marked as reported" "$(markers)" "0"
NOTIFIER=notify-broken run badlog OK >/dev/null
check "and it is still nothing after a second cycle"        "$(markers)" "0"
run badlog OK >/dev/null
check "so once the notifier works the warning arrives"      "$(notifications)" "1"
check "and only then is it marked"                          "$(markers)" "1"

# --- 10. a broken config check is reported ------------------------------------
: > "${notify_out}"
rm -rf "${work}/data"
rc="$(CHECKER=check-broken run goodlog OK)"
check "a config check producing nothing exits non-zero" "${rc}" "1"
check "and is notified"                                 "$(notifications)" "1"
said="$(cat "${notify_out}")"
if [[ "${said}" == *"configuration check"* ]]; then
    ok "and the notification names the configuration check"
else
    bad "the notification does not name the check: ${said}"
fi

# --- 11. a log source answering 200 with nothing in it is not health ----------
cat > "${work}/emptylog" <<'STUB'
#!/usr/bin/env bash
printf '\n200'
STUB
chmod +x "${work}/emptylog"
: > "${notify_out}"
rm -rf "${work}/data"
rc="$(run emptylog OK)"
check "an empty log with a 200 exits non-zero" "${rc}" "1"
check "and is notified"                        "$(notifications)" "1"

# --- 12. a partial answer with a failed exit is not taken as an answer --------
# Only `set -o pipefail` makes that exit status visible at all; without it the
# status belongs to the last command in the pipe, which always succeeds.
: > "${notify_out}"
rm -rf "${work}/data"
rc="$(run goodlog 'a partial ans' 1)"
check "a partial answer with a failed exit is reported" "${rc}" "1"
said="$(cat "${notify_out}")"
if [[ "${said}" == *"not producing an answer"* ]]; then
    ok "and it is reported as a broken check, not as a finding"
else
    bad "a failed run was passed on as if it were a finding: ${said}"
fi

printf '\n%s\n' "$([ "${fails}" -eq 0 ] && echo 'all checks passed' || echo "${fails} check(s) failed")"
exit $(( fails > 0 ))
