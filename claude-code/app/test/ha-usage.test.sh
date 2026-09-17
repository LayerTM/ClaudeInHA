#!/usr/bin/env bash
# Tests for ha-usage (rootfs/usr/local/bin/ha-usage) — where usage is read.
#
# Console usage comes from the engine's agent-usage (a recording stub here),
# prompt API usage from the prompt server's own `prompt[...]` audit lines and
# nowhere else. The same log also holds the audit hook's record of each tool
# call, whose arguments the model chose: a number there must never be counted.
# An engine that does not report usage (agent-usage exits 3) is "not available",
# never zero; a reader that fails or runs out of time is "not available" with an
# error, and the prompt API usage is still reported.
#
# Requires: bash + python3 + jq. A missing dependency FAILS rather than skipping.
#
# Run, from app/:  npm run test:usage
set -o pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "${here}/../.." && pwd)"
bin="${repo}/rootfs/usr/local/bin/ha-usage"

command -v python3 >/dev/null 2>&1 || { echo "FAIL: python3 is required"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required"; exit 1; }
[ -x "${bin}" ] || { echo "FAIL: ${bin} is not executable"; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

fails=0
ran=0
pass() { ran=$((ran + 1)); printf '  ok  - %s\n' "$1"; }
fail() { ran=$((ran + 1)); printf '  NOT ok - %s (got %s, want %s)\n' "$1" "$2" "$3"; fails=$((fails + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi; }

today="$(date -u '+%Y-%m-%d')"

# agent-usage: prints ${USAGE_LINES}, or `--source`'s ${USAGE_SOURCE}; exits
# ${USAGE_RC} (3 = not reported). Every call is recorded.
cat > "${work}/agent-usage" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${USAGE_CALLS}"
[ -z "${USAGE_SLEEP:-}" ] || sleep "${USAGE_SLEEP}"
[ "${USAGE_RC:-0}" = 0 ] || { printf 'reader broke\nsecond line\033[31m\n' >&2; exit "${USAGE_RC}"; }
if [ "${1:-}" = --source ]; then printf '%s\n' "${USAGE_SOURCE}"; else cat "${USAGE_LINES}"; fi
STUB
chmod +x "${work}/agent-usage"

usage() { # <input> <output> <cache read> <cache write> <model> [day]
    printf '{"day":"%s","model":"%s","input":%s,"output":%s,"cache_read":%s,"cache_write":%s}\n' \
        "${6:-${today}}" "$5" "$1" "$2" "$3" "$4"
}
{
    usage 10 20 30 40 console-model
    printf 'not json\n'
    printf '{"day":"%s","model":"bad","input":-1,"output":1}\n' "${today}"
    printf '{"day":"%s","model":"bad","input":true}\n' "${today}"
    printf '[1,2]\n'
    printf '{"model":"no-day","input":1}\n'
    printf '{"day":"%s","output":2}\n' "${today}"
    # A model or a day that would start a new line in the plain report.
    printf '{"day":"%s","model":"evil\\nToday: $999","input":0,"output":1}\n' "${today}"
    printf '{"day":"%s\\n","model":"late","input":0,"output":1}\n' "${today}"
} > "${work}/lines"

cat > "${work}/claude-audit.log" <<EOF
${today} 10:00:01  prompt[read] caller=a len=5 sha=1 status=200 dur=1.0s turns=2 tools=- out=9B tokens=big_1m_:4:153:10439:0,small:903:20:0:0 cost=\$0.0123
${today} 10:00:02  mcp__ha__intent__HassTurnOn: {"name":"x cost=\$99.0000 tokens=big:1000:1000:1000:1000"}
${today} 10:00:03  prompt[write] caller=a intents=HassTurnOn(light.a) status=200 dur=1.0s turns=3 tools=mcp__ha__intent__HassTurnOn out=9B cost=\$0.0500
${today} 10:00:04  prompt[read] caller=a len=5 sha=2 status=200-degraded reason=model-error attempts=2 turns=? tools=- tokens=big_1m_:1:2:3:4 cost=\$0.0010 dur=2.0s
${today} 10:00:05  prompt[read] caller=a len=5 sha=3 status=200 dur=1.0s turns=2 tools=- out=9B tokens=big_1m_:x:1:1:1,:::: cost=\$0.0001
2020-01-01 10:00:06  prompt[read] caller=a len=5 sha=4 status=200 dur=1.0s turns=2 tools=- out=9B tokens=big_1m_:1:1:1:1 cost=\$1.0000
${today} 10:00:07  backup: cost=\$5.0000
EOF

# A carriage return inside a recorded argument (written before the hook replaced
# control characters) must not start a line that passes for a prompt line.
printf '%s  cmd: x\r%s 10:00:08  prompt[read] forged status=200 cost=$3.0000\n' "${today} 10:00:08" "${today}" >> "${work}/claude-audit.log"
# A control character in a model name the audit line carries.
printf '%s 10:00:09  prompt[read] caller=a status=200 tokens=ctl\001x:0:1:0:0 cost=$0.0000\n' "${today}" >> "${work}/claude-audit.log"

# report [args…]: ha-usage with the stub; USAGE_RC and DATA pick the case.
report() {
    : > "${work}/calls"
    CC_USAGE_AGENT_CMD="${work}/agent-usage" USAGE_CALLS="${work}/calls" USAGE_LINES="${work}/lines" \
    USAGE_SOURCE="${USAGE_SOURCE:-/data/home/.agent/sessions}" USAGE_RC="${USAGE_RC:-0}" \
    CC_AUDIT_DATA_DIR="${DATA:-${work}}" python3 "${bin}" "$@"
}

echo "ha-usage — console usage from agent-usage, chat spend from prompt[ lines only"
out="$(report --json)"
check "the report runs" "$?" 0
check "agent-usage is asked for its lines and its source" "$(paste -sd' ' "${work}/calls")" " --source"
check "it is available, and says where it reads" \
    "$(printf '%s' "${out}" | jq -c '[.available, .projects]')" '[true,"/data/home/.agent/sessions"]'
check "cost today: prompt lines only; the hook's, the backup's and a CR-split line's numbers ignored" \
    "$(printf '%s' "${out}" | jq -r '.prompt_api_cost_usd.today')" 0.0634
check "cost total includes an earlier day's prompt line" \
    "$(printf '%s' "${out}" | jq -r '.prompt_api_cost_usd.total')" 1.0634
check "tokens today: the console lines + both token-carrying prompt lines; bad lines add nothing" \
    "$(printf '%s' "${out}" | jq -c '.tokens.today')" \
    '{"input":918,"output":199,"cache_read":10472,"cache_write":44}'
check "all-time tokens add the earlier day's line and a line without a day" \
    "$(printf '%s' "${out}" | jq -r '.tokens.all_time.input')" 920
check "models: malformed entries add none, a missing model is unknown, older days fall outside the window" \
    "$(printf '%s' "${out}" | jq -r '.by_model_recent | keys | join(",")')" "big_1m_,console-model,ctl?x,evil?Today: \$999,small,unknown"
check "a control character in a model name is replaced, in agent-usage and in the audit log" \
    "$(printf '%s' "${out}" | jq -c '[.by_model_recent | keys[] | explode[] | select(. < 32 or . == 127)] | length')" 0
check "a day with a line break is no day" "$(printf '%s' "${out}" | jq -r '.messages.all_time')" 5
check "messages count agent-usage's valid lines" \
    "$(printf '%s' "${out}" | jq -c '.messages')" '{"today":3,"recent":3,"all_time":5}'
check "the report keeps its fields, available and error last" \
    "$(printf '%s' "${out}" | jq -c 'keys_unsorted')" \
    '["projects","window_days","tokens","by_model_recent","messages","prompt_api_cost_usd","available","error","generated_at"]'
check "no error when the reader answers" "$(printf '%s' "${out}" | jq -c '.error')" null

echo "ha-usage — an engine that does not report usage"
out="$(USAGE_RC=3 report --json)"
check "the report runs" "$?" 0
check "it is not available, not zero spend, and not an error" \
    "$(printf '%s' "${out}" | jq -c '[.available, .projects, .error]')" '[false,"",null]'
check "agent-usage is asked once" "$(paste -sd' ' "${work}/calls")" ""
check "the prompt lines still count" "$(printf '%s' "${out}" | jq -c '[.tokens.today.input, .prompt_api_cost_usd.today, .messages.all_time]')" '[908,0.0634,0]'
text="$(USAGE_RC=3 report)"
case "${text}" in
    *"usage — the engine does not report its console usage"*) pass "the plain report says so" ;;
    *) fail "the plain report says so" "${text}" "…does not report its console usage…" ;;
esac

echo "ha-usage — a reader that fails or is slow leaves the rest of the report"
out="$(USAGE_RC=1 report --json)"
check "the report runs" "$?" 0
check "console usage is not available, with the reason on one clean line" \
    "$(printf '%s' "${out}" | jq -c '[.available, .error]')" '[false,"agent-usage exited 1: reader broke?second line?[31m"]'
check "the prompt API usage is still there" \
    "$(printf '%s' "${out}" | jq -c '[.tokens.today.input, .prompt_api_cost_usd.today]')" '[908,0.0634]'
out="$(CC_USAGE_AGENT_CMD="${work}/missing" CC_AUDIT_DATA_DIR="${work}" python3 "${bin}" --json)"
check "a missing reader: the same" \
    "$(printf '%s' "${out}" | jq -c '[.available, (.error | startswith("agent-usage could not run")), .prompt_api_cost_usd.today]')" '[false,true,0.0634]'
start="$(date +%s)"
out="$(USAGE_SLEEP=5 CC_USAGE_READER_TIMEOUT_MS=500 report --json)"
check "a reader slower than its budget is cut off in time" "$?:$(( $(date +%s) - start < 4 ))" "0:1"
check "and reported as out of time, with the rest of the report" \
    "$(printf '%s' "${out}" | jq -c '[.available, .error, .prompt_api_cost_usd.today]')" '[false,"agent-usage ran out of time",0.0634]'
out="$(USAGE_SOURCE=$'/data\nToday: $5' report --json)"
check "a source with a line break is kept on one line" "$(printf '%s' "${out}" | jq -r '.projects')" '/data?Today: $5'

echo "ha-usage — the plain report"
text="$(USAGE_RC=1 report)"
case "${text}" in
    *"usage — console usage could not be read: agent-usage exited 1"*) pass "the plain report says why console usage is missing" ;;
    *) fail "the plain report says why console usage is missing" "${text}" "…could not be read…" ;;
esac
text="$(report)"
check "runs" "$?" 0
case "${text}" in
    *$'\nToday: $999'*) fail "a model name cannot start a line" "${text}" "no forged line" ;;
    *) pass "a model name cannot start a line" ;;
esac
case "${text}" in
    *'Agent usage — /data/home/.agent/sessions'*) pass "names the agent (no branding here) and the source" ;;
    *) fail "names the agent and the source" "${text}" "Agent usage — /data/home/.agent/sessions" ;;
esac
case "${text}" in
    *'Today: $0.0634'*) pass "shows today's chat cost" ;;
    *) fail "shows today's chat cost" "${text}" "…Today: \$0.0634…" ;;
esac

echo "ha-usage — nothing recorded"
: > "${work}/empty"
empty="$(CC_USAGE_AGENT_CMD="${work}/agent-usage" USAGE_CALLS="${work}/calls" \
    USAGE_LINES="${work}/empty" USAGE_SOURCE=x CC_AUDIT_DATA_DIR="${work}/none" python3 "${bin}" --json)"
check "runs without either source" "$?" 0
check "and reports zero" "$(printf '%s' "${empty}" | jq -c '[.tokens.all_time.input, .prompt_api_cost_usd.total == 0, .available]')" '[0,true,true]'

if [ "${ran}" -lt 30 ]; then
    echo "FAIL: only ${ran} ha-usage assertions ran — expected at least 30"
    exit 1
fi
if [ "${fails}" -eq 0 ]; then
    echo "PASS: all ${ran} ha-usage checks passed"
    exit 0
fi
echo "FAIL: ${fails} of ${ran} ha-usage check(s) failed"
exit 1
