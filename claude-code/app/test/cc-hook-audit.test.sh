#!/usr/bin/env bash
# Tests for cc-hook-audit (rootfs/usr/local/bin/cc-hook-audit) — the PostToolUse
# hook that records the HA-affecting actions Claude takes.
#
# Regression guard, in two halves.
#
# THE HOOK: it only ever handled Bash/Edit/Write/MultiEdit, and its registration
# matched the same four names. MCP tools are named mcp__<server>__<tool>, so when
# the bundled Home Assistant MCP server gained nine tools that write to Lovelace
# dashboards, every one of those writes landed with nothing in the audit log.
# Nothing was broken and nothing was reported — the log simply could not see that
# class of action at all.
#
# THE MIGRATION, which is the half that is easy to miss: /data survives an add-on
# update and the hooks block has been seeded there since v1.4.0, so the seed
# guard ("the user has no hooks of their own") is false on every existing
# installation. A matcher fixed only in the seed ships in the image and reaches
# nobody who already has the add-on — the same defect shape as the one above,
# one layer up. So the migration is asserted here too, in both directions: our
# own superseded matcher is updated, and a matcher the user has touched is not.
#
# The polarity cases are the important ones. An UNKNOWN verb must be logged
# rather than skipped, so a tool this hook has never seen cannot go unrecorded by
# virtue of being new; a future "tidy-up" that turns the read-only allowlist into
# a write DENYLIST passes every write case below and fails those.
#
# Requires: bash + jq. No Home Assistant, no Supervisor, no container. A missing
# dependency FAILS rather than skipping: a skip and a pass are the same exit code
# in a pipeline, so a green CI must mean the assertions actually ran.
#
# Run:  bash claude-code/app/test/cc-hook-audit.test.sh
#   or, from claude-code/app:  npm run test:audit
set -o pipefail

here="$(cd "$(dirname "$0")" && pwd)"
addon="$(cd "${here}/../.." && pwd)"                 # claude-code/
hook="${addon}/rootfs/usr/local/bin/cc-hook-audit"
run="${addon}/rootfs/etc/s6-overlay/s6-rc.d/claude-code/run"
lib="${addon}/rootfs/usr/local/lib/addon-hooks.sh"

command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required by this test and by the hook itself"; exit 1; }
# Not -x: the tracked file is mode 644 and the image chmods it at build time,
# so the test runs it through bash the same way the harness would.
[ -f "${hook}" ] || { echo "FAIL: ${hook} is missing"; exit 1; }
[ -f "${run}" ]  || { echo "FAIL: ${run} is missing"; exit 1; }
[ -f "${lib}" ]  || { echo "FAIL: ${lib} is missing"; exit 1; }
# shellcheck source=../../rootfs/usr/local/lib/addon-hooks.sh
source "${lib}"

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
export CC_AUDIT_DATA_DIR="${work}"
log="${work}/claude-audit.log"

fails=0
ran=0
# The number of assertions that actually ran is printed at the end. A skip and a
# pass are the same exit code in a pipeline, so the count is what distinguishes
# "everything passed" from "nothing was measured".
pass() { ran=$((ran + 1)); printf '  ok  - %s\n' "$1"; }
fail() { ran=$((ran + 1)); printf '  NOT ok - %s (got %s, want %s)\n' "$1" "$2" "$3"; fails=$((fails + 1)); }
check() { [ "$2" = "$3" ] && pass "$1" || fail "$1" "$2" "$3"; }

# Lines the hook appends for one tool call. The payload shape is the one Claude
# Code sends a PostToolUse hook on stdin.
logged() {
    : > "${log}"
    printf '%s' "$1" | bash "${hook}" >/dev/null 2>&1
    [ -f "${log}" ] || { printf '0'; return; }
    printf '%s' "$(wc -l < "${log}" | tr -d ' ')"
}

# The text of the single line the hook wrote (empty when it wrote nothing).
logged_line() {
    : > "${log}"
    printf '%s' "$1" | bash "${hook}" >/dev/null 2>&1
    tr -d '\n' < "${log}"
}

mcp() { printf '{"tool_name":"mcp__%s__%s","tool_input":%s}' "$1" "$2" "${3:-\{\}}"; }

echo "cc-hook-audit — the shell and file cases it always covered"

bashcall() { printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(printf '%s' "$1" | jq -Rs .)"; }
filecall() { printf '{"tool_name":"%s","tool_input":{"file_path":"%s"}}' "$1" "$2"; }

check "a Core restart is logged" \
    "$(logged "$(bashcall 'ha core restart')")" 1
check "a service call through the Core API is logged" \
    "$(logged "$(bashcall 'curl -X POST http://homeassistant:8123/core/api/services/light/turn_on')")" 1
check "an ordinary shell command is not logged" \
    "$(logged "$(bashcall 'ls -la /tmp')")" 0
check "an edit inside the config tree is logged" \
    "$(logged "$(filecall Edit /homeassistant/automations.yaml)")" 1
check "an edit outside the config tree is not logged" \
    "$(logged "$(filecall Write /data/workdir/notes.md)")" 0
# NotebookEdit reaches the hook because the matcher's `Edit` is an unanchored
# regex, and it names its target notebook_path rather than file_path — so reading
# only file_path would make handling it a silent no-op.
check "a NotebookEdit in the config tree is logged (notebook_path, not file_path)" \
    "$(logged "$(printf '{"tool_name":"NotebookEdit","tool_input":{"notebook_path":"/homeassistant/notes.ipynb"}}')")" 1
check "a NotebookEdit outside the config tree is not logged" \
    "$(logged "$(printf '{"tool_name":"NotebookEdit","tool_input":{"notebook_path":"/data/workdir/x.ipynb"}}')")" 0

echo "cc-hook-audit — dashboard writes through MCP"

# The nine hass-mcp tools that change a dashboard. Each must produce a line.
for t in add_card update_card move_card remove_card add_view update_view remove_view \
         set_dashboard_config restore_dashboard; do
    check "logs mcp write: ${t}" "$(logged "$(mcp hass-mcp "${t}" '{"url_path":"lovelace"}')")" 1
done

echo "cc-hook-audit — reads stay out of the log"

for t in get_dashboard_config list_dashboards list_view_sections list_dashboard_backups \
         get_entity list_entities search_entities_tool get_history get_statistics \
         get_error_log system_overview domain_summary_tool; do
    check "read is not logged: ${t}" "$(logged "$(mcp hass-mcp "${t}" '{}')")" 0
done

for t in browser_snapshot browser_take_screenshot browser_console_messages browser_network_requests; do
    check "playwright read is not logged: ${t}" "$(logged "$(mcp playwright "${t}" '{}')")" 0
done

echo "cc-hook-audit — a noun suffix must not pass for a read verb"

# These were skipped while the allowlist carried *_messages, *_requests and
# *_snapshot as patterns: the suffix looked like a read and swallowed the verb in
# front of it, on every server. Scoping Playwright's reads to their exact names
# is what makes these three land.
check "send_messages is a write, not a read" \
    "$(logged "$(mcp some-server send_messages '{}')")" 1
check "approve_requests is a write, not a read" \
    "$(logged "$(mcp some-server approve_requests '{}')")" 1
check "reset_snapshot is a write, not a read" \
    "$(logged "$(mcp some-server reset_snapshot '{}')")" 1
check "a browser read name on another server is not privileged" \
    "$(logged "$(mcp other browser_snapshot_delete '{}')")" 1

echo "cc-hook-audit — polarity: unknown means logged"

check "a verb this hook has never seen is LOGGED, not skipped" \
    "$(logged "$(mcp some-server zzz_未知_verb '{"a":1}')")" 1
check "a tool from an unknown server is LOGGED" \
    "$(logged "$(mcp brand-new-server flip_the_thing '{}')")" 1

echo "cc-hook-audit — what the line says"

case "$(logged_line "$(mcp hass-mcp add_card '{"url_path":"lovelace","card":{"type":"button"}}')")" in
    *"mcp__hass-mcp__add_card"*) pass "the line names the full tool, server included" ;;
    *) fail "the line names the full tool, server included" "$(logged_line "$(mcp hass-mcp add_card '{}')")" "…mcp__hass-mcp__add_card…" ;;
esac

case "$(logged_line "$(mcp hass-mcp add_card '{"url_path":"lovelace","card":{"type":"button"}}')")" in
    *'"url_path":"lovelace"'*) pass "the line carries the arguments" ;;
    *) fail "the line carries the arguments" "(no url_path)" '…"url_path":"lovelace"…' ;;
esac

# A dashboard configuration is large; one call must not fill the log. Built with
# jq rather than python3 so the case cannot be skipped for a missing dependency.
filler="$(printf 'x%.0s' $(seq 1 4000))"
bigcall() {
    jq -nc --arg s "${filler}" --argjson dry "$1" \
        '{tool_name:"mcp__hass-mcp__set_dashboard_config",
          tool_input:{url_path:"lovelace", config:{views:[{cards:[$s]}]}, dry_run:$dry},
          tool_response:{dry_run:$dry}}'
}
len="$(printf '%s' "$(logged_line "$(bigcall false)")" | wc -c | tr -d ' ')"
[ "${len}" -lt 400 ] && pass "a huge argument set is truncated (${len} chars)" \
    || fail "a huge argument set is truncated" "${len}" "<400"

echo "cc-hook-audit — a preview is not recorded as a change"

# The dashboard tools take dry_run LAST in their arguments, so on a large call the
# 300-character cap cut it off and a preview produced a byte-identical line to a
# real write. The marker now goes before the arguments, where the cap cannot
# reach it — and it is read from the tool's reply as well as its arguments.
case "$(logged_line "$(bigcall true)")" in
    *"(dry-run)"*) pass "a large dry-run call is marked as a preview" ;;
    *) fail "a large dry-run call is marked as a preview" "$(logged_line "$(bigcall true)")" "…(dry-run)…" ;;
esac
case "$(logged_line "$(bigcall false)")" in
    *"(dry-run)"*) fail "a real write is NOT marked as a preview" "marked" "unmarked" ;;
    *) pass "a real write is NOT marked as a preview" ;;
esac
# The two must no longer be indistinguishable — that was the defect.
if [ "$(logged_line "$(bigcall true)")" = "$(logged_line "$(bigcall false)")" ]; then
    fail "a preview and a real write produce different lines" "identical" "different"
else
    pass "a preview and a real write produce different lines"
fi
# Only an explicit dry_run marks a preview; anything unproven is a change.
case "$(logged_line "$(mcp hass-mcp add_card '{"url_path":"lovelace"}')")" in
    *"(dry-run)"*) fail "no dry_run flag means a change, not a preview" "marked" "unmarked" ;;
    *) pass "no dry_run flag means a change, not a preview" ;;
esac
# The reply is consulted even when the arguments do not carry the flag, including
# the content-array shape an MCP server usually returns.
case "$(logged_line "$(printf '%s' '{"tool_name":"mcp__hass-mcp__set_dashboard_config","tool_input":{"url_path":"lovelace"},"tool_response":{"content":[{"type":"text","text":"{\"dry_run\": true, \"summary\": \"1 card\"}"}]}}')")" in
    *"(dry-run)"*) pass "a dry-run reported only in the reply is still marked" ;;
    *) fail "a dry-run reported only in the reply is still marked" "unmarked" "…(dry-run)…" ;;
esac

echo "cc-hook-audit — the hook is actually registered for MCP tools"

# A hook that handles MCP tools but is never invoked for them is the same blind
# spot with more code, so the matcher is asserted too.
case "${CC_HOOK_AUDIT_MATCHER}" in
    *mcp__*) pass "PostToolUse matcher covers mcp__ tools (${CC_HOOK_AUDIT_MATCHER})" ;;
    *) fail "PostToolUse matcher covers mcp__ tools" "${CC_HOOK_AUDIT_MATCHER}" "…mcp__…" ;;
esac
# ...and the service script must actually call the seeder, or the library above
# is correct and orphaned.
case "$(cat "${run}")" in
    *"hooks_seed_or_migrate"*) pass "the service script calls hooks_seed_or_migrate" ;;
    *) fail "the service script calls hooks_seed_or_migrate" "absent" "present" ;;
esac
case "$(cat "${run}")" in
    *"source /usr/local/lib/addon-hooks.sh"*) pass "and sources the library that defines it" ;;
    *) fail "and sources the library that defines it" "absent" "present" ;;
esac

echo "hooks_seed_or_migrate — the fix has to reach an EXISTING installation"

# /data persists across updates, so this is the path every current user takes.
settings="${work}/settings.json"
matcher_of() { jq -r '.hooks.PostToolUse[0].matcher // ""' "${settings}"; }
cmd_of()     { jq -r '.hooks.PostToolUse[0].hooks[0].command // ""' "${settings}"; }

# A fresh install: no hooks at all.
printf '%s' '{}' > "${settings}"
check "a fresh install is seeded" "$(hooks_seed_or_migrate "${settings}")" seeded
check "and gets the current matcher" "$(matcher_of)" "${CC_HOOK_AUDIT_MATCHER}"
check "seeding twice changes nothing" "$(hooks_seed_or_migrate "${settings}")" unchanged

# An existing installation, seeded by v1.4.0 and carried across every update
# since. This is the case the seed guard skips and the whole point of the block.
existing='{"hooks":{"PreToolUse":[{"matcher":"Bash|Edit|Write|MultiEdit","hooks":[{"type":"command","command":"/usr/local/bin/cc-hook-backup"}]}],"PostToolUse":[{"matcher":"Bash|Edit|Write|MultiEdit","hooks":[{"type":"command","command":"/usr/local/bin/cc-hook-audit"}]}],"Notification":[{"hooks":[{"type":"command","command":"/usr/local/bin/cc-hook-notify"}]}]}}'
printf '%s' "${existing}" > "${settings}"
check "an existing installation is migrated" "$(hooks_seed_or_migrate "${settings}")" migrated
check "and ends up on the current matcher" "$(matcher_of)" "${CC_HOOK_AUDIT_MATCHER}"
check "migrating twice changes nothing" "$(hooks_seed_or_migrate "${settings}")" unchanged
printf '%s' "${existing}" > "${settings}"
hooks_seed_or_migrate "${settings}" >/dev/null
check "the other hooks are left alone" \
    "$(jq -r '.hooks.PreToolUse[0].matcher + " " + (.hooks.Notification | length | tostring)' "${settings}")" \
    "Bash|Edit|Write|MultiEdit 1"

# The direction that matters just as much: a matcher the user has edited is not
# ours to rewrite.
printf '%s' '{"hooks":{"PostToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"/usr/local/bin/cc-hook-audit"}]}]}}' > "${settings}"
check "a user-edited matcher is NOT migrated" "$(hooks_seed_or_migrate "${settings}")" unchanged
check "and keeps exactly what the user wrote" "$(matcher_of)" "Bash"

# Someone else's hook on our old matcher is not ours either.
printf '%s' '{"hooks":{"PostToolUse":[{"matcher":"Bash|Edit|Write|MultiEdit","hooks":[{"type":"command","command":"/usr/local/bin/their-own-hook"}]}]}}' > "${settings}"
check "another command on our old matcher is untouched" "$(hooks_seed_or_migrate "${settings}")" unchanged
check "and keeps its own command" "$(cmd_of)" "/usr/local/bin/their-own-hook"

# Hooks present but none of ours, and no PostToolUse key at all: nothing to do,
# and nothing invented either.
printf '%s' '{"hooks":{"Notification":[{"hooks":[{"type":"command","command":"/usr/local/bin/theirs"}]}]}}' > "${settings}"
check "a hooks config without ours is untouched" "$(hooks_seed_or_migrate "${settings}")" unchanged
check "and no empty PostToolUse is invented" "$(jq -r 'has("hooks") and (.hooks | has("PostToolUse"))' "${settings}")" false

echo
# A floor on the assertion count, so a future edit that guts the file cannot
# report success by running almost nothing.
if [ "${ran}" -lt 55 ]; then
    echo "FAIL: only ${ran} cc-hook-audit assertions ran — expected at least 55"
    exit 1
fi
if [ "${fails}" -eq 0 ]; then
    echo "PASS: all ${ran} cc-hook-audit checks passed"
    exit 0
fi
echo "FAIL: ${fails} of ${ran} cc-hook-audit check(s) failed"
exit 1
