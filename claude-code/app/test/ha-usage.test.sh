#!/usr/bin/env bash
# Tests for ha-usage (rootfs/usr/local/bin/ha-usage) — where chat spend is read.
#
# Chat requests keep no transcript, so their tokens and cost come from the
# prompt server's own `prompt[...]` audit lines and nowhere else. The same log
# also holds the audit hook's record of each tool call, whose arguments the model
# chose: a number there must never be counted. Transcripts are read from every
# project directory: the prompt server removes the ones earlier versions saved
# for chat requests before anything else at start, so the report does not need
# to know where they were.
#
# Requires: bash + python3 + jq. A missing dependency FAILS rather than skipping.
#
# Run:  bash claude-code/app/test/ha-usage.test.sh
#   or, from claude-code/app:  npm run test:usage
set -o pipefail

here="$(cd "$(dirname "$0")" && pwd)"
addon="$(cd "${here}/../.." && pwd)"                 # claude-code/
bin="${addon}/rootfs/usr/local/bin/ha-usage"

command -v python3 >/dev/null 2>&1 || { echo "FAIL: python3 is required"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required"; exit 1; }
[ -f "${bin}" ] || { echo "FAIL: ${bin} is missing"; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

fails=0
ran=0
pass() { ran=$((ran + 1)); printf '  ok  - %s\n' "$1"; }
fail() { ran=$((ran + 1)); printf '  NOT ok - %s (got %s, want %s)\n' "$1" "$2" "$3"; fails=$((fails + 1)); }
check() { [ "$2" = "$3" ] && pass "$1" || fail "$1" "$2" "$3"; }

today="$(date -u '+%Y-%m-%d')"
usage_line() { # <input> <output> <cache read> <cache write> <model>
    printf '{"timestamp":"%sT10:00:00Z","message":{"model":"%s","usage":{"input_tokens":%s,"output_tokens":%s,"cache_read_input_tokens":%s,"cache_creation_input_tokens":%s}}}\n' \
        "${today}" "$5" "$1" "$2" "$3" "$4"
}

report() { HOME="${work}/home" CC_AUDIT_DATA_DIR="${work}" python3 "${bin}" --json; }

mkdir -p "${work}/home/.claude/projects/-homeassistant"
usage_line 10 20 30 40 console-model > "${work}/home/.claude/projects/-homeassistant/console.jsonl"

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

echo "ha-usage — chat spend comes from prompt[ lines only"
out="$(report)"
check "the report runs" "$?" 0
check "cost today: prompt lines only; the hook's, the backup's and a CR-split line's numbers ignored" \
    "$(printf '%s' "${out}" | jq -r '.prompt_api_cost_usd.today')" 0.0634
check "cost total includes an earlier day's prompt line" \
    "$(printf '%s' "${out}" | jq -r '.prompt_api_cost_usd.total')" 1.0634
check "tokens today: console transcript + both token-carrying prompt lines" \
    "$(printf '%s' "${out}" | jq -c '.tokens.today')" \
    '{"input":918,"output":195,"cache_read":10472,"cache_write":44}'
check "all-time tokens add the earlier day's line" \
    "$(printf '%s' "${out}" | jq -r '.tokens.all_time.input')" 919
check "models: malformed tokens entries add none, older days fall outside the window" \
    "$(printf '%s' "${out}" | jq -r '.by_model_recent | keys | join(",")')" "big_1m_,console-model,small"
# A transcript whose removal failed is read like any other one.
left="${work}/left"
mkdir -p "${left}/home/.claude/projects/-data-claude-prompt-work"
usage_line 7 0 0 0 left-model > "${left}/home/.claude/projects/-data-claude-prompt-work/old.jsonl"
check "a transcript left in the chat work folder's directory is counted" \
    "$(HOME="${left}/home" CC_AUDIT_DATA_DIR="${left}" python3 "${bin}" --json | jq -r '.by_model_recent["left-model"].input')" 7
check "messages count the console transcript only" \
    "$(printf '%s' "${out}" | jq -r '.messages.today')" 1

echo "ha-usage — the plain report"
text="$(HOME="${work}/home" CC_AUDIT_DATA_DIR="${work}" python3 "${bin}")"
check "runs" "$?" 0
case "${text}" in
    *'Today: $0.0634'*) pass "shows today's chat cost" ;;
    *) fail "shows today's chat cost" "${text}" "…Today: \$0.0634…" ;;
esac

echo "ha-usage — no audit log, no transcripts"
empty="$(HOME="${work}/none" CC_AUDIT_DATA_DIR="${work}/none" python3 "${bin}" --json)"
check "runs without either source" "$?" 0
check "and reports zero" "$(printf '%s' "${empty}" | jq -c '[.tokens.all_time.input, .prompt_api_cost_usd.total == 0]')" '[0,true]'

if [ "${ran}" -lt 12 ]; then
    echo "FAIL: only ${ran} ha-usage assertions ran — expected at least 12"
    exit 1
fi
if [ "${fails}" -eq 0 ]; then
    echo "PASS: all ${ran} ha-usage checks passed"
    exit 0
fi
echo "FAIL: ${fails} of ${ran} ha-usage check(s) failed"
exit 1
