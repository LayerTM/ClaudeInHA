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
#   6. the prompt actually reaches the analysing command.
#
# Case 6 is the one with history: passed as a positional argument the prompt is
# consumed by --allowed-tools, which takes a list, and the command exits with no
# input. Nothing downstream could tell that from a healthy, quiet instance.
#
# Requires: bash. No live Home Assistant needed.
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
: > "${notify_out}"

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
[ -n "\${CLAUDE_ANSWER:-}" ] && printf '%s\n' "\${CLAUDE_ANSWER}"
exit "\${CLAUDE_RC:-0}"
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

chmod +x "${work}"/notify "${work}"/claude "${work}"/check "${work}"/goodlog "${work}"/badlog

fails=0
ok()   { printf 'PASS  %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fails=$((fails + 1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want '$3', got '$2')"; fi; }

# $1 = log stub, $2 = CLAUDE_ANSWER, $3 = CLAUDE_RC ; prints the exit status
run() {
    CC_MONITOR_DATA_DIR="${work}/data" \
    CC_MONITOR_NOTIFY_CMD="${work}/notify" \
    CC_MONITOR_CHECK_CMD="${work}/check" \
    CC_MONITOR_CURL="${work}/$1" \
    CC_MONITOR_CLAUDE_CMD="${work}/claude" \
    CLAUDE_ANSWER="$2" CLAUDE_RC="${3:-0}" \
        bash "${script}" --once >/dev/null 2>&1
    printf '%s' "$?"
}

notifications() { wc -l < "${notify_out}" | tr -d ' '; }

# --- 1. healthy: nothing is notified -----------------------------------------
rc="$(run goodlog OK)"
check "a healthy run exits 0"                 "${rc}" "0"
check "a healthy run notifies nothing"        "$(notifications)" "0"

# --- 6. the prompt reaches the command, on stdin ------------------------------
if rg -q 'ERROR LOG' "${claude_in}" && rg -q 'something' "${claude_in}"; then
    ok "the prompt and the log reach the analysing command"
else
    bad "the prompt never reached the analysing command (stdin was: $(head -c 80 "${claude_in}"))"
fi

# The colour codes journald emits are noise to a reader and to the model.
if rg -q "$(printf '\033')" "${claude_in}"; then
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
if rg -qi 'cannot read' "${notify_out}"; then
    ok "and the notification says the check is not running"
else
    bad "the notification does not say the check stopped: $(cat "${notify_out}")"
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
if rg -qi 'not producing an answer' "${notify_out}"; then
    ok "and the notification says nothing is being reported"
else
    bad "the notification does not describe the silence: $(cat "${notify_out}")"
fi

# An empty answer with a ZERO exit is the same defect wearing a different hat.
: > "${notify_out}"
rm -rf "${work}/data"
rc="$(run goodlog '' 0)"
check "an empty answer with exit 0 is also reported" "$(notifications)" "1"
check "and it exits non-zero"                 "${rc}" "1"

printf '\n%s\n' "$([ "${fails}" -eq 0 ] && echo 'all checks passed' || echo "${fails} check(s) failed")"
exit $(( fails > 0 ))
