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
#   6. the prompt actually reaches the analysing command (agent-ask, on stdin);
#   7. agent-ask gets no arguments and no Home Assistant credentials (no tools
#      and no permission bypass are agent-ask's own contract);
#   8. every external call is time-limited;
#   9. a notifier that cannot deliver does not silence the warning for good;
#  10. records the known-noise list names (the shipped list: Home Assistant's
#      rejections of the CLI's `server/discover` request) are left out whole, a
#      log of nothing else is still a readable log, and a new list line is all
#      it takes to leave out another kind;
#  11. the analysis sees the last records, each cut to a size: one huge record
#      cannot hide the others;
#  12. enough of the journal is read for that window, and a window that stays
#      short says so rather than reading like a quiet log.
#
# Case 6 is the one with history: passed as a positional argument after a CLI
# option that takes a list, the prompt was consumed as a list item and the
# command exited with no input. Nothing downstream could tell that from a
# healthy, quiet instance.
#
# Requires: bash, and nothing else. The assertions use bash's own pattern
# matching rather than an external matcher on purpose: a missing tool makes
# `if <tool> ...` false, and a check written as if/else then reports PASS from
# its else branch — passing because the instrument is dead.
#
# Run, from app/:  npm run test:monitor
set -o pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "${here}/../.." && pwd)"
script="${repo}/rootfs/usr/local/bin/cc-monitor"

[ -x "${script}" ] || { echo "FAIL: ${script} is not executable"; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

notify_out="${work}/notified.txt"
agent_in="${work}/agent-stdin.txt"
agent_argv="${work}/agent-argv.txt"
agent_env="${work}/agent-env.txt"
timeout_used="${work}/timeout-used.txt"
: > "${notify_out}"
: > "${timeout_used}"

# Records every notification so the assertions can read them back.
cat > "${work}/notify" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$1" >> "${notify_out}"
printf '%s\n' "\$2" >> "${notify_out}.titles"
printf '%s\n' "\$1" >> "${notify_out}.all"
STUB

# Records what the analysing command actually received on stdin, then answers
# with whatever the case asked for via AGENT_ANSWER (empty answer + a non-zero
# exit reproduces the failure this script used to swallow).
cat > "${work}/agent" <<STUB
#!/usr/bin/env bash
cat > "${agent_in}"
printf '%s\n' "\$*" > "${agent_argv}"
leaked=''; for v in SUPERVISOR_TOKEN SUPERVISOR_API_TOKEN HA_TOKEN HASS_TOKEN; do [ -n "\${!v:-}" ] && leaked="\${leaked}\${v} "; done; printf '%s' "\${leaked}" > "${agent_env}"
[ -n "\${AGENT_ANSWER:-}" ] && printf '%s\n' "\${AGENT_ANSWER}"
exit "\${AGENT_RC:-0}"
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

# The shape Home Assistant logs a rejected `server/discover` in (shortened from
# 31 validation errors), coloured as journald sends it: a fragment of one whose
# header fell before the window, a whole one, a real error, and another whole one
# that pads past the analysis window on its own.
discover_record() {
    printf '\033[33m%s WARNING (MainThread) [root] Failed to validate request: 31 validation errors for ClientRequest\033[0m\n' "$1"
    local i
    for i in $(seq 1 100); do
        printf "PingRequest%s.method\n  Input should be 'ping' [type=literal_error, input_value='server/discover', input_type=str]\n" "${i}"
    done
}
{
    printf '#!/usr/bin/env bash\n'
    printf 'cat <<'"'"'LOG'"'"'\n'
    printf "  Input should be 'resources/read' [type=literal_error, input_value='server/discover', input_type=str]\n"
    discover_record '2026-09-16 18:18:39.352'
    printf '\033[31m2026-09-16 18:19:00.001 ERROR (MainThread) [homeassistant.components.foo] Setup of foo failed: REAL-FAILURE-MARK\033[0m\n'
    discover_record '2026-09-16 18:19:28.432'
    printf 'LOG\n'
    printf 'printf 200\n'
} > "${work}/noisylog"
{
    printf '#!/usr/bin/env bash\n'
    printf 'cat <<'"'"'LOG'"'"'\n'
    discover_record '2026-09-16 18:18:39.352'
    printf 'LOG\n'
    printf 'printf 200\n'
} > "${work}/onlynoise"

# log_stub <name> <body file>: a curl stand-in that answers with the file and a 200.
log_stub() {
    printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" > %q\ncat %q\nprintf 200\n' "${work}/curl-args.txt" "$2" > "${work}/$1"
}
# A real error, one record far larger than the window, then another real error.
{
    printf '2026-09-16 18:19:30.000 ERROR (MainThread) [homeassistant.components.baz] BEFORE-FLOOD-MARK\n'
    printf '2026-09-16 18:20:00.000 ERROR (MainThread) [homeassistant.components.big] Traceback FLOOD-START\n'
    for i in $(seq 1 2000); do printf '  File "/usr/src/x.py", line %s, in handler\n' "${i}"; done
    printf '2026-09-16 18:21:00.000 ERROR (MainThread) [homeassistant.components.bar] AFTER-FLOOD-MARK\n'
} > "${work}/flood.txt"
log_stub floodlog "${work}/flood.txt"
# Twenty short records: only the last ones reach the analysis.
for i in $(seq -w 1 20); do
    printf '2026-09-16 18:30:%s.000 WARNING (MainThread) [homeassistant.components.n] RECORD-%s\n' "${i}" "${i}"
done > "${work}/many.txt"
log_stub manylog "${work}/many.txt"
# A kind of noise the shipped list does not name, and a list that names it.
{
    printf '2026-09-16 18:40:00.000 WARNING (MainThread) [homeassistant.components.q] NEW-NOISE-MARK something harmless\n'
    printf '2026-09-16 18:41:00.000 ERROR (MainThread) [homeassistant.components.r] KEPT-MARK\n'
} > "${work}/newnoise.txt"
log_stub newnoiselog "${work}/newnoise.txt"
printf '# test list\nNEW-NOISE-MARK\thttps://example.invalid/issue\n' > "${work}/noise-list.tsv"

chmod +x "${work}"/notify "${work}"/notify-broken "${work}"/agent "${work}"/check \
         "${work}"/check-broken "${work}"/goodlog "${work}"/badlog "${work}"/timeout \
         "${work}"/noisylog "${work}"/onlynoise "${work}"/floodlog "${work}"/manylog "${work}"/newnoiselog

fails=0
ok()   { printf 'PASS  %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fails=$((fails + 1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want '$3', got '$2')"; fi; }

# $1 = log stub, $2 = AGENT_ANSWER, $3 = AGENT_RC ; prints the exit status
run() {
    CC_MONITOR_DATA_DIR="${work}/data" \
    CC_MONITOR_NOTIFY_CMD="${work}/${NOTIFIER:-notify}" \
    CC_MONITOR_CHECK_CMD="${work}/${CHECKER:-check}" \
    CC_MONITOR_CURL="${work}/$1" \
    CC_MONITOR_AGENT_CMD="${work}/agent" \
    CC_MONITOR_TIMEOUT_CMD="${work}/timeout" \
    CC_MONITOR_KNOWN_NOISE="${KNOWN_NOISE:-${repo}/rootfs/usr/share/agent-core/monitor-known-noise.tsv}" \
    SUPERVISOR_TOKEN="tok-supervisor" SUPERVISOR_API_TOKEN="tok-api" \
    HA_TOKEN="tok-ha" HASS_TOKEN="tok-hass" \
    AGENT_ANSWER="$2" AGENT_RC="${3:-0}" \
        bash "${script}" --once >/dev/null 2>&1
    printf '%s' "$?"
}

markers() {
    local n=0 f
    for f in "${work}/data"/*; do [ -e "${f}" ] && n=$((n + 1)); done
    printf '%s' "${n}"
}

notifications() { wc -l < "${notify_out}" | tr -d ' '; }

# --- 1. healthy: nothing is notified -----------------------------------------
rc="$(run goodlog OK)"
check "a healthy run exits 0"                 "${rc}" "0"
check "a healthy run notifies nothing"        "$(notifications)" "0"

# --- 6. the prompt reaches the command, on stdin ------------------------------
seen="$(cat "${agent_in}")"
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

# --- 10. known noise is left out, whole ---------------------------------------
: > "${notify_out}"
rm -rf "${work}/data"
run noisylog OK >/dev/null
seen="$(cat "${agent_in}")"
if [[ "${seen}" == *"REAL-FAILURE-MARK"* ]]; then
    ok "a real error next to the noise reaches the analysis"
else
    bad "the real error was pushed out of the analysis (stdin began: ${seen:0:120})"
fi
if [[ "${seen}" == *"server/discover"* || "${seen}" == *"Failed to validate request"* ]]; then
    bad "server/discover rejections reached the analysis"
else
    ok "server/discover rejections are left out, header and body"
fi
rc="$(run onlynoise OK)"
check "a log of nothing but known noise is a readable log" "${rc}" "0"
check "and it notifies nothing"               "$(notifications)" "0"
seen="$(cat "${agent_in}")"
if [[ "${seen}" == *"holds only 0 entries apart from known, harmless ones"* ]]; then
    ok "the analysis is told the log held only known entries"
else
    bad "an empty remainder was not stated (stdin began: ${seen:0:120})"
fi
run newnoiselog OK >/dev/null
seen="$(cat "${agent_in}")"
check "the shipped list does not name the new kind" "$([[ "${seen}" == *NEW-NOISE-MARK* ]] && echo kept)" "kept"
KNOWN_NOISE="${work}/noise-list.tsv" run newnoiselog OK >/dev/null
seen="$(cat "${agent_in}")"
check "one list line leaves the new kind out" "$([[ "${seen}" == *NEW-NOISE-MARK* ]] && echo kept || echo dropped)" "dropped"
check "and only that kind"                    "$([[ "${seen}" == *KEPT-MARK* ]] && echo kept)" "kept"
rm -rf "${work}/data"

# --- 11. one huge record cannot hide the others ---------------------------------
run floodlog OK >/dev/null
seen="$(cat "${agent_in}")"
check "a record before a huge one reaches the analysis" "$([[ "${seen}" == *BEFORE-FLOOD-MARK* ]] && echo yes)" "yes"
check "a record after a huge one reaches the analysis" "$([[ "${seen}" == *AFTER-FLOOD-MARK* ]] && echo yes)" "yes"
check "the huge record is there, cut and marked" \
    "$([[ "${seen}" == *FLOOD-START* && "${seen}" == *'[...truncated]'* ]] && echo yes)" "yes"
if [ "${#seen}" -lt 10000 ]; then
    ok "the analysis input stays small (${#seen} characters)"
else
    bad "the analysis input grew to ${#seen} characters"
fi
run manylog OK >/dev/null
seen="$(cat "${agent_in}")"
check "the newest record is there"            "$([[ "${seen}" == *RECORD-20* ]] && echo yes)" "yes"
check "the 15th newest is there"              "$([[ "${seen}" == *RECORD-06* ]] && echo yes)" "yes"
check "the 16th newest is not"                "$([[ "${seen}" == *RECORD-05* ]] && echo yes || echo no)" "no"
check "a full window carries no shortness note" "$([[ "${seen}" == *"holds only"* ]] && echo yes || echo no)" "no"

# --- 12. enough is read, and a short window says so ---------------------------
curl_args="$(cat "${work}/curl-args.txt")"
check "the journal is read 5000 entries deep"  "$([[ "${curl_args}" == *'Range: entries=:-5000:'* ]] && echo yes)" "yes"
run newnoiselog OK >/dev/null
seen="$(cat "${agent_in}")"
check "a short window states how many entries it has" \
    "$([[ "${seen}" == *"holds only 2 entries apart from known, harmless ones"* ]] && echo yes)" "yes"
rm -rf "${work}/data"

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
# Cleared first so the assertions below cannot read a file some EARLIER run
# wrote. Without this, a build where the command is never invoked at all leaves
# the previous contents in place and every check here passes on stale evidence.
rm -f "${agent_argv}" "${agent_env}" "${agent_in}"
run goodlog OK >/dev/null

# One stuck call would stop the loop, and a loop that is not looping notifies
# exactly as often as a healthy one: never. Counted for THIS run — the counter is
# cleared above, because it accumulates across every run in the file.
check "the log fetch and the analysis are both time-limited" \
      "$(wc -l < "${timeout_used}" | tr -d ' ')" "2"

if [ -e "${agent_argv}" ]; then
    ok "the analysing command was invoked at all"
else
    bad "the analysing command was never invoked — every check below would measure nothing"
fi

# Exact equality: agent-ask takes the prompt on stdin and nothing else, so any
# argument here is one the engine was never asked to accept.
check "agent-ask is run with no arguments" \
      "$(cat "${agent_argv}" 2>/dev/null)" ""

# Bash builtins, not an external matcher: a matcher with a GNU-only alternation
# matches nothing on BSD, so the check would report "nothing leaked" on a build
# where everything did — and keep doing so.
check "no Home Assistant credentials reach the model's environment" \
      "$(cat "${agent_env}" 2>/dev/null)" ""

# The recorder must be able to SEE a leak, or its silence means nothing.
SUPERVISOR_TOKEN="tok" SUPERVISOR_API_TOKEN="tok" HA_TOKEN="tok" HASS_TOKEN="tok" \
    "${work}/agent" </dev/null >/dev/null 2>&1
if [ -n "$(cat "${agent_env}" 2>/dev/null)" ]; then
    ok "and the recorder that says so can see a leak when there is one"
else
    bad "the credential check cannot see anything — it would pass no matter what"
fi
rm -f "${agent_argv}" "${agent_env}"

# The environment is one route in; the prompt is the other, and it is the one a
# reader would assume "reaches the model" covers.
run goodlog OK >/dev/null
if [[ "$(cat "${agent_in}")" != *"tok-supervisor"* ]]; then
    ok "and no credential is pasted into the prompt itself"
else
    bad "a Home Assistant token was interpolated into the prompt"
fi

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

# --- 13. a stop signal stops it, promptly -------------------------------------
# Bash defers signal handling until the foreground child returns whenever ANY
# trap is installed — an EXIT trap is enough. A cycle can sit inside an analysis
# for minutes, so a trap added here to tidy a temp file would make the add-on
# refuse to shut down for that long. Measured both ways before it was removed;
# this keeps it removed.
cat > "${work}/slowagent" <<'STUB'
#!/usr/bin/env bash
cat > /dev/null
sleep 30
STUB
chmod +x "${work}/slowagent"

# Wrapped so the shell's own "Terminated" job notice, which goes to stderr when
# the job is reaped, does not look like an error in the CI log.
shutdown_case() {
    rm -rf "${work}/data"
    CC_MONITOR_DATA_DIR="${work}/data" CC_MONITOR_NOTIFY_CMD="${work}/notify" \
    CC_MONITOR_CHECK_CMD="${work}/check" CC_MONITOR_CURL="${work}/goodlog" \
    CC_MONITOR_AGENT_CMD="${work}/slowagent" CC_MONITOR_TIMEOUT_CMD="" \
        bash "${script}" --once >/dev/null 2>&1 &
    local mon_pid=$!
    sleep 2
    kill -TERM "${mon_pid}" 2>/dev/null
    sleep 2
    if kill -0 "${mon_pid}" 2>/dev/null; then
        bad "a stop signal did not stop it — the add-on would hang on shutdown"
        kill -9 "${mon_pid}" 2>/dev/null
    else
        ok "a stop signal stops it while an analysis is still running"
    fi
    wait "${mon_pid}" 2>/dev/null || true
}
shutdown_case 2>/dev/null

# --- 14. titles and texts name the agent -----------------------------------------
# No add-on console here, so no branding.json: the fallback name is used.
titles="$(sort -u "${notify_out}.titles")"
check "every notification is titled with the agent's name" "${titles}" "Agent · HA health check"
if [[ "$(cat "${notify_out}.all")" == *"Agent cannot read the Home Assistant log"* ]]; then
    ok "and the texts name it too"
else
    bad "a text does not name the agent"
fi

printf '\n%s\n' "$([ "${fails}" -eq 0 ] && echo 'all checks passed' || echo "${fails} check(s) failed")"
exit $(( fails > 0 ))
