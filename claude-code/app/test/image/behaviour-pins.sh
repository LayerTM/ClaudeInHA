#!/usr/bin/env bash
# Behaviour pins that only the built image can answer: what the service script
# sets up and exports, how the Claude tab is launched, how the CLI is updated
# (from a shell and from the console's Update button), what provisioning
# installs, how the health check and the morning digest call Claude through
# agent-ask, and that a prompt API run leaves nothing agent-usage counts.
#
# Runs as root inside a throwaway container of the add-on image:
#   docker run --rm -v "$PWD/claude-code/app/test/image:/pins-src:ro" \
#     --entrypoint bash <image> /pins-src/behaviour-pins.sh
#
# The Claude CLI is replaced by a recording fake (nothing reaches the network),
# and the add-on options are served to bashio from its own cache directory,
# which is where bashio looks before it asks the Supervisor.
set -u

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok   $1"; }
bad() { fail=$((fail + 1)); echo "FAIL $1"; if [ -n "${2:-}" ]; then printf '     %s\n' "$2"; fi; }
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "got [$2] want [$3]"; fi; }
yes_() { if "${@:2}"; then ok "$1"; else bad "$1"; fi; }
no_() { if "${@:2}"; then bad "$1"; else ok "$1"; fi; }

P=/pins
SERVICE=/etc/s6-overlay/s6-rc.d/claude-code/run
BASE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
IMG=5.0.0
rm -rf "${P}"
mkdir -p "${P}"

# --- fakes -------------------------------------------------------------------
# mkfake <path> <version> [broken]: a `claude` that logs every call (arguments
# quoted, working directory, HOME) and carries its version inside itself, so a
# copy made by the service script reports the version of what was copied.
mkfake() {
    mkdir -p "$(dirname "$1")"
    rm -f "$1"
    cat > "$1" <<EOF
#!/bin/bash
FAKE_VERSION=$2
[ "${3:-0}" = 1 ] && exit 127
{ printf '%s|%s|%s|' "\$(readlink -f "\$0")" "\$(pwd)" "\$HOME"; [ \$# -gt 0 ] && printf '%q ' "\$@"; echo; } >> /pins/claude.log
for a in "\$@"; do printf '%s' "\$a" | jq -Rs .; done | jq -cs . >> /pins/claude-args.jsonl
if [ -f /pins/log-env ]; then env | cut -d= -f1 | sort | tr '\n' , >> /pins/claude-env.log; echo >> /pins/claude-env.log; fi
# What is installed lives in /pins/*-list, in the shape the real CLI lists it,
# so provisioning sees what an earlier run added.
case "\$*" in
    --version) echo "\${FAKE_VERSION} (Claude Code)" ;;
    update) if [ -f /pins/update-fails ]; then echo "update refused" >&2; exit 3; fi; echo "checked for updates" ;;
    "install "*) sed -i "s/^FAKE_VERSION=.*/FAKE_VERSION=\$2/" "\$(readlink -f "\$0")"; echo "installed \$2" ;;
    "plugin marketplace list") cat /pins/mp-list 2>/dev/null ;;
    "plugin marketplace add "*) echo "  added (\$4)" >> /pins/mp-list ;;
    "plugin list") cat /pins/plugin-list 2>/dev/null ;;
    "plugin install "*) echo "  ❯ \$3" >> /pins/plugin-list ;;
    "mcp list") cat /pins/mcp-list 2>/dev/null ;;
    "mcp add "*) echo "\$3: registered" >> /pins/mcp-list ;;
    *)
        # Like the real CLI: in print mode the prompt is a positional argument or
        # stdin, and a list flag (--allowed-tools …) consumes every argument after
        # it. With neither, the CLI refuses with this message and exit 1.
        if [[ " \$* " == *" -p "* ]]; then
            positional=0; in_list=0
            for a in "\$@"; do
                case "\$a" in
                    --allowed-tools|--allowedTools|--disallowed-tools|--disallowedTools|--tools|--add-dir|--mcp-config|--betas|--file) in_list=1 ;;
                    -*) in_list=0 ;;
                    *) [ "\$in_list" = 1 ] || positional=1 ;;
                esac
            done
            if [ "\$positional" = 0 ]; then
                cat > /pins/claude-stdin.txt
                if [ ! -s /pins/claude-stdin.txt ]; then
                    echo "Error: Input must be provided either through stdin or as a prompt argument when using --print" >&2
                    exit 1
                fi
            fi
        fi
        if [ "\$HOME" = /tmp/cc-skipcheck ]; then
            [ -f /pins/skipcheck-refuses ] && echo "--dangerously-skip-permissions cannot be used with root/sudo privileges"
        elif [ ! -f /pins/claude-silent ]; then
            echo "Good morning from the pins"
        fi
        ;;
esac
exit 0
EOF
    chmod +x "$1"
}

# The image's own copy becomes a fake of version IMG. The real binary stays in
# /root/.local/share/claude and is not used by anything below.
mkfake /root/.local/bin/claude "${IMG}"

# The console process the service script ends in: record how it was started.
mkdir -p /usr/local/sbin
cat > /usr/local/sbin/node <<'EOF'
#!/bin/bash
printf '%s\n' "$*" > /pins/console-args
/usr/local/bin/node -e 'require("fs").writeFileSync("/pins/console-env.json", JSON.stringify(process.env))'
EOF
chmod +x /usr/local/sbin/node

DEFAULTS='{"api_key":"","oauth_token":"","ha_token":"","bypass_permissions":false,"auto_update":true,"model":"",
"custom_instructions":"","environment_vars":[],"init_commands":[],"plugins":[],"marketplaces":[],"skills_git":"",
"extra_args":[],"launch_command":"","quick_prompts":[],"upload_retention_days":14,"remote_control":false,
"monitoring_interval_hours":0,"daily_digest_time":"","proactive_alerts":false,"proactive_alerts_interval_minutes":15,
"prompt_api":true,"api_token":"","prompt_ha_token":"","chat_model":"","chat_daily_budget_usd":0}'

# options <json overrides>: /data/options.json plus bashio's cached copy of it.
options() {
    local merged
    merged="$(jq -cn --argjson a "${DEFAULTS}" --argjson b "$1" '$a + $b')"
    mkdir -p /data /tmp/.bashio
    rm -f /tmp/.bashio/*
    printf '%s' "${merged}" > /data/options.json
    printf '%s' "${merged}" > /tmp/.bashio/addons.self.options.config.cache
    printf '%s' '7.7.7' > /tmp/.bashio/addons.self.version.cache
}

reset() {
    rm -rf /data /homeassistant /tmp/cc-skipcheck
    rm -f "${P}"/claude.log "${P}"/claude-env.log "${P}"/console-* "${P}"/update-fails "${P}"/skipcheck-refuses \
        "${P}"/claude-silent "${P}"/log-env "${P}"/init-ran "${P}"/launched "${P}"/sleep.log "${P}"/notify.log "${P}"/curl.log \
        "${P}"/claude-args.jsonl "${P}"/mp-list "${P}"/plugin-list "${P}"/mcp-list "${P}"/shell-ran
    mkdir -p /data
}

envv() { jq -r --arg k "$1" 'if has($k) then .[$k] else "<unset>" end' "${P}/console-env.json"; }
persistent_version() { /data/home/.local/bin/claude --version 2>/dev/null | awk '{print $1}'; }
claude_calls() { cut -d'|' -f4- "${P}/claude.log" 2>/dev/null | sed 's/ $//'; }

# The container environment s6 keeps for its services. with-contenv starts the
# service with exactly these (and PATH), so PINS_NOT_CONTENV below must not
# reach the console and PINS_CONTENV must.
mkdir -p /run/s6/container_environment
printf '/root' > /run/s6/container_environment/HOME
printf 'from-contenv' > /run/s6/container_environment/PINS_CONTENV

# run_service: the s6 service script, as the Supervisor starts it (minus s6).
run_service() {
    env -i PATH="${BASE_PATH}" PINS_NOT_CONTENV=1 timeout 90 "${SERVICE}" > "${P}/run.out" 2>&1
    local status=$?
    # provisioning is started in the background; let it finish before asserting
    for _ in $(seq 1 60); do
        grep -q 'provisioning complete' /data/provision.log 2>/dev/null && break
        sleep 0.5
    done
    return "${status}"
}

expected_claude_md() {
    cat /usr/share/claude-ha/CLAUDE.md
    if [ -n "${1:-}" ]; then printf "\n\n---\n\n# User Custom Instructions\n\n%s\n" "$1"; fi
}

# The audit hook the prompt API is handed, stated here rather than rebuilt with
# the same helper the service script uses, so a change to that helper shows up.
AUDIT_SETTINGS='{"hooks":{"PostToolUse":[{"matcher":"Bash|Edit|Write|MultiEdit|^mcp__","hooks":[{"type":"command","command":"/usr/local/bin/cc-hook-audit"}]}]}}'

# The names the service script hands to the console, started from an empty
# environment (fresh install, api_key, model, auto_update off, one user
# variable). bashio's own bookkeeping (LOG_FD, __BASHIO_*), libuv's own
# (UV_USE_IO_URING — set by libuv itself under Rosetta-emulated amd64, even
# from an empty environment) and the shell's (PWD, SHLVL, _) are left out:
# they belong to the tools, not to this add-on.
# A change here that is intended is made by editing this list.
EXPECTED_CONSOLE_ENV="ADDON_VERSION ANTHROPIC_API_KEY ANTHROPIC_MODEL CLAUDE_CONSOLE_DEV CLAUDE_CONSOLE_PORT
CLAUDE_PROMPT_BIN CLAUDE_PROMPT_DATA CLAUDE_PROMPT_DEV CLAUDE_PROMPT_OPTIONS CLAUDE_PROMPT_PORT
CLAUDE_PROMPT_SETTINGS CLAUDE_PROMPT_USAGE_BIN DISABLE_AUTOUPDATER HA_URL HOME IS_SANDBOX LANG PATH
PINS_CONTENV PINS_FOO REMOTE_CONTROL TERM UPLOAD_DIR UPLOAD_RETENTION_DAYS USE_BUILTIN_RIPGREP"
check_console_env_names() {
    local got want added removed
    got="$(jq -r 'keys[]' "${P}/console-env.json" | grep -vE '^(LOG_FD|__BASHIO_.*|UV_USE_IO_URING|PWD|SHLVL|_)$' | sort)"
    want="$(tr ' ' '\n' <<< "${EXPECTED_CONSOLE_ENV}" | sed '/^$/d' | sort)"
    added="$(comm -23 <(echo "${got}") <(echo "${want}") | tr '\n' ' ')"
    removed="$(comm -13 <(echo "${got}") <(echo "${want}") | tr '\n' ' ')"
    if [ -z "${added}${removed}" ]; then
        ok "console environment has exactly the recorded names"
    else
        bad "console environment has exactly the recorded names" \
            "added: [${added}] missing: [${removed}] — if the service script changed this on purpose, update EXPECTED_CONSOLE_ENV in ${BASH_SOURCE[0]}"
    fi
}

# --- 1. service script, fresh install -----------------------------------------
echo "# service script: fresh install"
reset
echo '{"active":[],"items":[]}' > /data/alerts-state.json
options '{"api_key":"sk-ant-api03-EXAMPLEimagepins000","model":"pins-model","custom_instructions":"PINS-CUSTOM-MARK",
"auto_update":false,"upload_retention_days":3,"remote_control":true,
"environment_vars":["PINS_FOO=bar","CLAUDE_PROMPT_BIN=/evil","CLAUDE_PROMPT_HA_MCP_URL=http://evil.example","CLAUDE_CONSOLE_DEV=1","CLAUDE_PROMPT_DEV=1","not-a-pair"]}'
run_service
eq "service script exits 0 after handing over to the console" "$?" 0
eq "console is started as the last step" "$(cat "${P}/console-args" 2>/dev/null)" "/opt/agent-console/server/index.js"
eq "the service hands the container environment to the start script" "$(envv PINS_CONTENV)" from-contenv
eq "and nothing else of its caller's" "$(envv PINS_NOT_CONTENV)" "<unset>"
yes_ "the start script names the product first" grep -q 'Initializing Claude Code add-on\.\.\.' "${P}/run.out"
yes_ "and the console last" grep -q 'Starting Claude Console on port 8099\.\.\.' "${P}/run.out"
eq "persistent CLI is seeded from the image" "$(persistent_version)" "${IMG}"
check_console_env_names
eq "PATH" "$(envv PATH)" "/data/home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
eq "HOME" "$(envv HOME)" /data/home
eq "IS_SANDBOX" "$(envv IS_SANDBOX)" 1
eq "TERM" "$(envv TERM)" xterm-256color
eq "LANG" "$(envv LANG)" C.UTF-8
eq "USE_BUILTIN_RIPGREP" "$(envv USE_BUILTIN_RIPGREP)" 0
eq "api_key → ANTHROPIC_API_KEY" "$(envv ANTHROPIC_API_KEY)" sk-ant-api03-EXAMPLEimagepins000
eq "model → ANTHROPIC_MODEL" "$(envv ANTHROPIC_MODEL)" pins-model
eq "auto_update off → DISABLE_AUTOUPDATER" "$(envv DISABLE_AUTOUPDATER)" 1
eq "environment_vars are exported" "$(envv PINS_FOO)" bar
eq "HA_URL without Supervisor" "$(envv HA_URL)" http://homeassistant:8123
eq "CLAUDE_CONSOLE_PORT" "$(envv CLAUDE_CONSOLE_PORT)" 8099
eq "CLAUDE_CONSOLE_DEV cannot be set from options" "$(envv CLAUDE_CONSOLE_DEV)" 0
eq "UPLOAD_DIR" "$(envv UPLOAD_DIR)" /data/uploads
eq "upload_retention_days → UPLOAD_RETENTION_DAYS" "$(envv UPLOAD_RETENTION_DAYS)" 3
eq "remote_control → REMOTE_CONTROL" "$(envv REMOTE_CONTROL)" true
eq "CLAUDE_PROMPT_PORT" "$(envv CLAUDE_PROMPT_PORT)" 8126
eq "CLAUDE_PROMPT_DEV cannot be set from options" "$(envv CLAUDE_PROMPT_DEV)" 0
eq "CLAUDE_PROMPT_DATA" "$(envv CLAUDE_PROMPT_DATA)" /data
eq "CLAUDE_PROMPT_OPTIONS" "$(envv CLAUDE_PROMPT_OPTIONS)" /data/options.json
eq "CLAUDE_PROMPT_BIN cannot be set from options" "$(envv CLAUDE_PROMPT_BIN)" /data/home/.local/bin/claude
eq "CLAUDE_PROMPT_USAGE_BIN" "$(envv CLAUDE_PROMPT_USAGE_BIN)" /usr/local/bin/ha-usage
eq "CLAUDE_PROMPT_HA_MCP_URL cannot be set from options" "$(envv CLAUDE_PROMPT_HA_MCP_URL)" "<unset>"
eq "CLAUDE_PROMPT_SETTINGS is the audit-hook settings" "$(envv CLAUDE_PROMPT_SETTINGS)" "${AUDIT_SETTINGS}"
eq "ADDON_VERSION from the Supervisor" "$(envv ADDON_VERSION)" 7.7.7
no_ "auto_update off → no update call" grep -q '|update $' "${P}/claude.log"
eq "CLAUDE.md = bundled + custom instructions" "$(cat /data/workdir/CLAUDE.md)" "$(expected_claude_md PINS-CUSTOM-MARK)"
no_ "no /homeassistant → nothing written there" test -e /homeassistant
eq "settings.json carries hooks and the status line" "$(jq -c 'keys' /data/home/.claude/settings.json)" '["hooks","statusLine"]'
eq "settings.json hook events" "$(jq -c '.hooks | keys' /data/home/.claude/settings.json)" '["Notification","PostToolUse","PreToolUse"]'
yes_ "ccstatusline settings are seeded" cmp -s /data/home/.config/ccstatusline/settings.json /usr/share/claude-ha/ccstatusline-settings.json
yes_ "working, upload and skills directories exist" test -d /data/workdir -a -d /data/uploads -a -d /data/home/.claude/skills
no_ "proactive alerts off → alerts state removed" test -e /data/alerts-state.json
yes_ "a malformed environment_vars entry is reported" grep -q 'Ignoring malformed environment_vars entry' "${P}/run.out"
eq "provisioning calls, in order" "$(claude_calls | grep -E '^(plugin|mcp) ' | tr '\n' ';')" \
"plugin marketplace list;plugin marketplace add anthropics/claude-plugins-official;plugin marketplace add anthropics/skills;plugin list;\
plugin install superpowers@claude-plugins-official;plugin install frontend-design@claude-plugins-official;\
plugin install skill-creator@claude-plugins-official;plugin install security-guidance@claude-plugins-official;\
plugin install context7@claude-plugins-official;plugin install code-review@claude-plugins-official;\
plugin install code-simplifier@claude-plugins-official;plugin install feature-dev@claude-plugins-official;\
plugin install commit-commands@claude-plugins-official;plugin install claude-md-management@claude-plugins-official;\
plugin install hookify@claude-plugins-official;plugin install document-skills@anthropic-agent-skills;\
mcp list;mcp add playwright -s user -- playwright-mcp --headless --no-sandbox --browser chromium --executable-path /usr/bin/chromium;"
yes_ "HA skill pack is synced" test -f /data/home/.claude/skills/ha-automation/SKILL.md

# --- 2. service script, existing install with a newer CLI --------------------
echo "# service script: existing install, persistent CLI newer than the image"
reset
mkfake /data/home/.local/bin/claude 9.0.0
mkdir -p /data/home/.claude /homeassistant
echo keep-me > /data/home/.claude/.credentials.json
echo USER-OWN > /homeassistant/CLAUDE.md
options '{"oauth_token":"EXAMPLE-oauth-image-pins","ha_token":"EXAMPLE-ha-image-pins","auto_update":true,
"init_commands":["touch /pins/init-ran"],"plugins":["extra@market"],"marketplaces":["owner/market"]}'
run_service
eq "service script exits 0" "$?" 0
eq "newer persistent CLI is kept" "$(persistent_version)" 9.0.0
yes_ "auto_update on → the persistent CLI is asked to update" grep -qE '^/data/home/\.local/bin/claude\|.*\|update $' "${P}/claude.log"
eq "oauth_token → CLAUDE_CODE_OAUTH_TOKEN" "$(envv CLAUDE_CODE_OAUTH_TOKEN)" EXAMPLE-oauth-image-pins
eq "no api_key → ANTHROPIC_API_KEY unset" "$(envv ANTHROPIC_API_KEY)" "<unset>"
eq "no model → ANTHROPIC_MODEL unset" "$(envv ANTHROPIC_MODEL)" "<unset>"
eq "auto_update on → DISABLE_AUTOUPDATER unset" "$(envv DISABLE_AUTOUPDATER)" "<unset>"
eq "ha_token → HA_TOKEN" "$(envv HA_TOKEN)" EXAMPLE-ha-image-pins
eq "ha_token → HASS_TOKEN" "$(envv HASS_TOKEN)" EXAMPLE-ha-image-pins
eq "ha_token → HASS_SERVER" "$(envv HASS_SERVER)" http://homeassistant:8123
yes_ "init_commands run" test -e "${P}/init-ran"
eq "an existing /homeassistant/CLAUDE.md is left alone" "$(cat /homeassistant/CLAUDE.md)" USER-OWN
eq "login state survives" "$(cat /data/home/.claude/.credentials.json)" keep-me
yes_ "user marketplace is added" grep -q '|plugin marketplace add owner/market $' "${P}/claude.log"
yes_ "user plugin is installed" grep -q '|plugin install extra@market $' "${P}/claude.log"
yes_ "HA token → hass-mcp is registered with it" grep -qF '|mcp add hass-mcp -s user -e HA_URL=http://homeassistant:8123 -e HA_TOKEN=EXAMPLE-ha-image-pins -- hass-mcp ' "${P}/claude.log"

# --- 3. service script, older CLI, failing update, empty /homeassistant -------
echo "# service script: persistent CLI older than the image, update fails"
reset
mkfake /data/home/.local/bin/claude 1.0.0
mkdir -p /data/home/.claude /homeassistant
echo keep-me > /data/home/.claude/.credentials.json
touch "${P}/update-fails"
options '{"auto_update":true}'
run_service
eq "a failed update does not stop the start" "$?" 0
eq "older persistent CLI is replaced by the image's" "$(persistent_version)" "${IMG}"
yes_ "the failed update is reported" grep -q 'Update check failed (non-critical)' "${P}/run.out"
eq "CLAUDE.md is placed in an empty /homeassistant" "$(cat /homeassistant/CLAUDE.md)" "$(expected_claude_md)"
eq "login state survives the sync" "$(cat /data/home/.claude/.credentials.json)" keep-me

# --- 4. service script, persistent CLI that cannot run ------------------------
echo "# service script: persistent CLI does not run"
reset
mkfake /data/home/.local/bin/claude 9.0.0 1
mkdir -p /data/home/.claude
echo keep-me > /data/home/.claude/.credentials.json
options '{"auto_update":false}'
run_service
eq "service script exits 0" "$?" 0
eq "a CLI that does not run is reinstalled from the image" "$(persistent_version)" "${IMG}"
yes_ "the reinstall is reported" grep -q 'Persistent Claude binary is missing or incompatible' "${P}/run.out"
eq "login state survives the reinstall" "$(cat /data/home/.claude/.credentials.json)" keep-me
# --- 5. service script, the two remaining version-sync branches ----------------
echo "# service script: persistent CLI equal to the image, image CLI unreadable"
reset
mkfake /data/home/.local/bin/claude "${IMG}"
options '{"auto_update":false}'
run_service
yes_ "equal versions: the version is reported" grep -q "Claude Code version: ${IMG}" "${P}/run.out"
no_ "equal versions: nothing is synced" grep -q 'syncing to persistent storage' "${P}/run.out"
reset
mkfake /data/home/.local/bin/claude 9.0.0
mkfake /root/.local/bin/claude "${IMG}" 1
options '{"auto_update":false}'
run_service
eq "image CLI unreadable: the start goes on" "$?" 0
yes_ "image CLI unreadable: the sync is skipped with a warning" grep -q 'Could not determine Claude version for binary sync' "${P}/run.out"
eq "image CLI unreadable: the persistent CLI is kept" "$(persistent_version)" 9.0.0
mkfake /root/.local/bin/claude "${IMG}"

# --- 6. provisioning, run on its own ---------------------------------------------
echo "# provision-extras"
provision() {
    env -i PATH="${BASE_PATH}" HOME=/root HA_TOKEN="${HA_TOKEN_IN:-}" HA_URL=http://homeassistant:8123 \
        CC_USER_MARKETPLACES="${MP_IN:-}" CC_USER_PLUGINS="${PL_IN:-}" CC_SKILLS_GIT="${GIT_IN:-}" \
        /usr/local/bin/provision-extras > "${P}/provision.out" 2>&1
}
changes() { claude_calls | grep -E '^(plugin marketplace add|plugin install|mcp add) ' | cut -d' ' -f1-4 | tr '\n' ';'; }
lists() { claude_calls | grep -E '^(plugin marketplace list|plugin list|mcp list)$' | tr '\n' ';'; }
change_count() { claude_calls | grep -cE '^(plugin marketplace add|plugin install|mcp add) '; }

reset
mkfake /data/home/.local/bin/claude "${IMG}"
HA_TOKEN_IN=EXAMPLE-ha-provision provision
eq "first run installs the whole bundled set" "$(change_count)" 16
rm -f "${P}/claude.log"
HA_TOKEN_IN=EXAMPLE-ha-provision provision
eq "second run installs nothing" "$(changes)" ""
eq "second run only reads what is installed" "$(lists)" "plugin marketplace list;plugin list;mcp list;mcp list;"
yes_ "second run completes" grep -q 'provisioning complete' "${P}/provision.out"

rm -f "${P}/claude.log"
grep -v 'hookify@' "${P}/plugin-list" > "${P}/plugin-list.new"
mv "${P}/plugin-list.new" "${P}/plugin-list"
MP_IN='owner/market' PL_IN='extra@market' provision
eq "only what is missing is installed, user additions included" "$(changes)" \
    "plugin marketplace add owner/market;plugin install hookify@claude-plugins-official;plugin install extra@market;"

reset
mkfake /data/home/.local/bin/claude "${IMG}"
printf '%s\n' '  official (anthropics/claude-plugins-official)' '  other (anthropics/skills-extra)' > "${P}/mp-list"
provision
eq "a marketplace is matched by its whole source, not by a longer one" \
    "$(changes | tr ';' '\n' | grep '^plugin marketplace add' | tr '\n' ';')" "plugin marketplace add anthropics/skills;"
no_ "no HA token: hass-mcp is not registered" grep -q '|mcp add hass-mcp' "${P}/claude.log"

reset
mkfake /data/home/.local/bin/claude "${IMG}"
mkdir -p /data/home/.claude
flock /data/home/.claude/.provision.lock sleep 4 &
locker=$!
sleep 0.5
provision
wait "${locker}"
yes_ "a second concurrent run skips" grep -q 'provisioning already running — skipping' "${P}/provision.out"
no_ "a skipped run calls nothing" test -s "${P}/claude.log"

reset
mkfake /data/home/.local/bin/claude "${IMG}"
mkdir -p /data/home/.claude/skills/ha-automation /data/home/.claude/skills/mine
echo edited > /data/home/.claude/skills/ha-automation/SKILL.md
echo my-own > /data/home/.claude/skills/mine/SKILL.md
provision
yes_ "a bundled skill edited in place is restored" cmp -s /data/home/.claude/skills/ha-automation/SKILL.md /opt/ha-skills/ha-automation/SKILL.md
eq "a skill of the user's own is left alone" "$(cat /data/home/.claude/skills/mine/SKILL.md)" my-own

repo=/pins/skills-repo
rm -rf "${repo}"
mkdir -p "${repo}/alpha" "${repo}/notes"
echo alpha-v1 > "${repo}/alpha/SKILL.md"
echo not-a-skill > "${repo}/notes/README.md"
gitc() { git -C "${repo}" -c user.name=pins -c user.email=pins@localhost "$@" > /dev/null 2>&1; }
git init -q "${repo}"
gitc add -A
gitc commit -qm one
GIT_IN="${repo}" provision
yes_ "skills_git: cloned" grep -q 'skills_git cloned' "${P}/provision.out"
eq "skills_git: a directory with SKILL.md becomes a skill" "$(cat /data/home/.claude/skills/alpha/SKILL.md 2>/dev/null)" alpha-v1
no_ "skills_git: a directory without SKILL.md does not" test -e /data/home/.claude/skills/notes
echo alpha-v2 > "${repo}/alpha/SKILL.md"
gitc commit -qam two
GIT_IN="${repo}" provision
yes_ "skills_git: pulled on the next run" grep -q 'skills_git pulled' "${P}/provision.out"
eq "skills_git: the skill follows the repository" "$(cat /data/home/.claude/skills/alpha/SKILL.md)" alpha-v2
mkdir -p /data/home/.claude/skills/mine-too "${repo}/beta" "${repo}/ha-automation"
echo my-own > /data/home/.claude/skills/mine-too/SKILL.md
echo beta > "${repo}/beta/SKILL.md"
echo shadow > "${repo}/ha-automation/SKILL.md"
gitc add -A
gitc commit -qm three
GIT_IN="${repo}" provision
eq "skills_git: a skill added to the repository arrives" "$(cat /data/home/.claude/skills/beta/SKILL.md 2>/dev/null)" beta
gitc rm -rq alpha ha-automation
gitc commit -qm four
GIT_IN="${repo}" provision
no_ "skills_git: a skill removed from the repository is removed" test -e /data/home/.claude/skills/alpha
yes_ "skills_git: the removal is logged" grep -q 'skills_git: removed alpha' "${P}/provision.out"
eq "skills_git: the skills it still has stay" "$(cat /data/home/.claude/skills/beta/SKILL.md 2>/dev/null)" beta
yes_ "skills_git: a bundled skill of the same name is kept" cmp -s /data/home/.claude/skills/ha-automation/SKILL.md /opt/ha-skills/ha-automation/SKILL.md
eq "skills_git: a skill of the user's own stays" "$(cat /data/home/.claude/skills/mine-too/SKILL.md 2>/dev/null)" my-own

rm -f /usr/local/sbin/node

# --- 5. the Claude tab (start-claude) ------------------------------------------
# start_claude: the launcher loops forever (restart menu); its first calls are the pin.
start_claude() {
    env -i PATH="${BASE_PATH}" HOME=/root timeout 4 bashio /usr/local/bin/start-claude < /dev/null > "${P}/start.out" 2>&1
}
first_launch() { grep -v -E '\|--version $' "${P}/claude.log" | grep -v '|/tmp/cc-skipcheck|' | head -1 | cut -d'|' -f2-; }

echo "# start-claude"
reset
mkfake /data/home/.local/bin/claude "${IMG}"
mkdir -p /homeassistant /data/workdir
options '{"bypass_permissions":true,"extra_args":["--model","x y"]}'
start_claude
eq "bypass on: the root guard is probed without credentials" \
    "$(grep '|/tmp/cc-skipcheck|' "${P}/claude.log" | head -1 | cut -d'|' -f4- | sed 's/ $//')" "--dangerously-skip-permissions -p ."
eq "bypass on: launched in /homeassistant with the flag and extra_args" \
    "$(first_launch)" "/homeassistant|/data/home|--dangerously-skip-permissions --model x\\ y "
yes_ "exit menu names the version" grep -q "Claude exited. \[Claude Code ${IMG}\]" "${P}/start.out"

reset
mkfake /data/home/.local/bin/claude "${IMG}"
mkdir -p /data/workdir
touch "${P}/skipcheck-refuses"
options '{"bypass_permissions":true}'
start_claude
eq "bypass refused by the CLI: launched without the flag, in /data/workdir" "$(first_launch)" "/data/workdir|/data/home|"
yes_ "bypass refused: the user is told" grep -q 'no longer' "${P}/start.out"

reset
mkfake /data/home/.local/bin/claude "${IMG}"
mkdir -p /data/workdir
options '{"bypass_permissions":false,"extra_args":["--verbose"]}'
start_claude
no_ "bypass off: no probe" grep -q '|/tmp/cc-skipcheck|' "${P}/claude.log"
eq "bypass off: launched with extra_args only" "$(first_launch)" "/data/workdir|/data/home|--verbose "

reset
mkfake /data/home/.local/bin/claude "${IMG}"
mkdir -p /data/workdir
options '{"bypass_permissions":true,"launch_command":"touch /pins/launched"}'
start_claude
yes_ "launch_command replaces the Claude launch" test -e "${P}/launched"
eq "launch_command: the CLI itself is not launched" "$(first_launch)" ""

# The restart menu, each choice typed as a user would.
menu() {
    reset
    mkfake /data/home/.local/bin/claude "${IMG}"
    mkdir -p /data/workdir
    options '{"bypass_permissions":false}'
    printf '%b' "$1" > "${P}/menu-input"
    env -i PATH="${BASE_PATH}" HOME=/root timeout 4 bashio /usr/local/bin/start-claude < "${P}/menu-input" > "${P}/start.out" 2>&1
}
calls_seq() { head -"$1" "${P}/claude-args.jsonl" | jq -c . | tr '\n' ' '; }
menu 'c'
eq "menu c: the last conversation is resumed" "$(calls_seq 3)" '[] ["--version"] ["--continue"] '
menu 'r'
eq "menu r: Claude is launched again" "$(calls_seq 3)" '[] ["--version"] [] '
menu 'u'
eq "menu u: the CLI is updated, then launched again" "$(calls_seq 6)" '[] ["--version"] ["--version"] ["update"] ["--version"] [] '
menu 'stouch /pins/shell-ran\nexit\n'
yes_ "menu s: a shell runs what is typed into it" test -e "${P}/shell-ran"
eq "menu s: after the shell, Claude is launched again" "$(calls_seq 3)" '[] ["--version"] [] '

# --- 6. update-claude ------------------------------------------------------------
echo "# update-claude"
reset
mkfake /data/home/.local/bin/claude 1.0.0
out="$(env -i PATH="${BASE_PATH}" /usr/local/bin/update-claude 2>&1)"
eq "no argument: exit 0" "$?" 0
eq "no argument: claude update" "$(claude_calls | grep -v -- '^--version' | tr '\n' ';')" "update;"
yes_ "no argument: no change is reported" grep -q 'Claude Code: 1.0.0 (no change)' <<< "${out}"
rm -f "${P}/claude.log"
out="$(env -i PATH="${BASE_PATH}" /usr/local/bin/update-claude 2.5.0 2>&1)"
eq "version: exit 0" "$?" 0
eq "version: claude install <v> --force" "$(claude_calls | grep -v -- '^--version' | tr '\n' ';')" "install 2.5.0 --force;"
yes_ "version: the change is reported" grep -q 'Claude Code: 1.0.0 -> 2.5.0' <<< "${out}"
yes_ "version: the session restart is advised" grep -q 'Restart the Claude session (not the add-on)' <<< "${out}"
touch "${P}/update-fails"
env -i PATH="${BASE_PATH}" /usr/local/bin/update-claude > /dev/null 2>&1
eq "a failing update keeps its exit status" "$?" 3
rm -f "${P}/update-fails"

# --- 7. the console's Update button (POST /api/cli/update) -----------------------
echo "# POST /api/cli/update"
reset
mkfake /data/home/.local/bin/claude 1.0.0
mkdir -p /data/uploads
cat > "${P}/cli-update.js" <<'EOF'
const express = require('/opt/agent-console/node_modules/express');
const { createRouter } = require('/opt/agent-console/server/api.js');
const app = express();
app.use('/api', createRouter({ uploadDir: '/data/uploads' }));
const server = app.listen(0, '127.0.0.1', async () => {
  const post = async (body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/cli/update`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const out = {};
  out.plain = await post({});
  out.version = await post({ target: '2.5.0' });
  out.invalid = await post({ target: '1.0; rm -rf /' });
  require('fs').writeFileSync('/pins/update-fails', '');
  out.failing = await post({});
  console.log(JSON.stringify(out));
  server.close();
});
EOF
res="$(cd /opt/agent-console && env -i PATH="${BASE_PATH}" HOME=/root timeout 60 /usr/local/bin/node "${P}/cli-update.js" 2>/dev/null)"
eq "plain update: status and versions" "$(jq -c '.plain | [.status, .body.before, .body.after, .body.changed]' <<< "${res}")" '[200,"1.0.0","1.0.0",false]'
yes_ "plain update: output is the script's" grep -q 'no change' <<< "$(jq -r '.plain.body.output' <<< "${res}")"
eq "plain update: response fields" "$(jq -c '.plain.body | keys' <<< "${res}")" '["after","before","changed","output"]'
eq "versioned update: status and versions" "$(jq -c '.version | [.status, .body.before, .body.after, .body.changed]' <<< "${res}")" '[200,"1.0.0","2.5.0",true]'
eq "invalid target is refused" "$(jq -c '.invalid' <<< "${res}")" '{"status":400,"body":{"error":"invalid target"}}'
eq "failing update → 500 with the same fields" "$(jq -c '.failing | [.status, (.body | keys)]' <<< "${res}")" '[500,["after","before","changed","output"]]'
eq "the button runs update-claude as the shell does" "$(claude_calls | grep -v -- '^--version' | tr '\n' ';')" "update;install 2.5.0 --force;update;"
rm -f "${P}/update-fails"

# --- 8. agent-ask, the health check and the morning digest ---------------------
# Both loops are the core's; they ask the engine's agent-ask. What reaches Claude
# must stay what the add-on's own loops sent: exactly `-p --allowed-tools ""`,
# the prompt on stdin, no Supervisor or Home Assistant credential.
echo "# agent-ask"
ask_fakes() {
    local bin=/pins/bin
    rm -rf "${bin}"
    mkdir -p "${bin}"
    mkfake /data/home/.local/bin/claude "${IMG}"
    cat > "${bin}/curl" <<'EOF'
#!/bin/bash
printf '%q ' "$@" >> /pins/curl.log; echo >> /pins/curl.log
case "$*" in
    *core/api/states*)
        echo '[{"entity_id":"weather.home","state":"sunny","attributes":{"friendly_name":"Pins Weather","temperature":21}},
{"entity_id":"light.hall","state":"on","attributes":{"friendly_name":"Pins Hall"}}]' ;;
    *)
        printf '2026-09-16 18:19:00.001 ERROR (MainThread) [homeassistant.components.pins] Setup failed: PINS-LOG-MARK\n200' ;;
esac
EOF
    printf '#!/bin/bash\necho "Configuration valid"\n' > "${bin}/check"
    printf '#!/bin/bash\nprintf "%%s\\n" "$1|$2" >> /pins/notify.log\n' > "${bin}/notify"
    chmod +x "${bin}/curl" "${bin}/check" "${bin}/notify"
}
# The loops' own environment when addon-run starts them, credentials included.
loop_env=(env -i PATH="${BASE_PATH}" HOME=/root SUPERVISOR_TOKEN=EXAMPLE-sup SUPERVISOR_API_TOKEN=EXAMPLE-sup
    HA_TOKEN=EXAMPLE-ha HASS_TOKEN=EXAMPLE-ha)
run_digest() {
    "${loop_env[@]}" CC_DIGEST_CURL=/pins/bin/curl CC_DIGEST_NOTIFY_CMD=/pins/bin/notify \
        timeout 60 /usr/local/bin/cc-digest --once > /dev/null 2> "${P}/digest.err" < /dev/null
}
run_monitor() {
    mkdir -p /pins/monitor-data
    "${loop_env[@]}" CC_MONITOR_CURL=/pins/bin/curl CC_MONITOR_CHECK_CMD=/pins/bin/check \
        CC_MONITOR_NOTIFY_CMD=/pins/bin/notify CC_MONITOR_DATA_DIR=/pins/monitor-data CLAUDE_MONITOR_HOURS=1 \
        timeout 60 /usr/local/bin/cc-monitor --once > /dev/null 2> "${P}/monitor.err" < /dev/null
}

reset
ask_fakes
out="$(printf 'PINS-QUESTION' | env -i PATH=/usr/bin:/bin HOME=/root /usr/local/bin/agent-ask)"
eq "agent-ask: exit 0 with an answer" "$?" 0
eq "agent-ask: the answer is Claude's" "${out}" "Good morning from the pins"
eq "agent-ask: Claude is called with exactly -p and an empty tool list" \
    "$(jq -c . "${P}/claude-args.jsonl")" '["-p","--allowed-tools",""]'
eq "agent-ask: the question goes in on stdin" "$(cat "${P}/claude-stdin.txt")" PINS-QUESTION
eq "agent-ask: it runs the persistent CLI" "$(cut -d'|' -f1 "${P}/claude.log")" /data/home/.local/bin/claude
reset
ask_fakes
printf '' | env -i PATH=/usr/bin:/bin HOME=/root /usr/local/bin/agent-ask > /dev/null 2>&1
eq "agent-ask: no question → the CLI's refusal is its exit status" "$?" 1

echo "# cc-digest"
reset
ask_fakes
touch "${P}/log-env"
run_digest
eq "digest: states are fetched from the Supervisor" "$(head -1 "${P}/curl.log")" \
    "-sS -H Authorization:\\ Bearer\\ EXAMPLE-sup http://supervisor/core/api/states "
eq "digest: Claude is called with exactly -p and an empty tool list" \
    "$(jq -c . "${P}/claude-args.jsonl")" '["-p","--allowed-tools",""]'
yes_ "digest: the prompt goes in on stdin and carries the snapshot as data" \
    bash -c 'grep -q "====HOME SNAPSHOT====" /pins/claude-stdin.txt && grep -q "Pins Weather" /pins/claude-stdin.txt'
yes_ "digest: Claude's environment was recorded" test -s "${P}/claude-env.log"
no_ "digest: no Supervisor or HA credential in Claude's environment" grep -qE '(^|,)(SUPERVISOR_TOKEN|SUPERVISOR_API_TOKEN|HA_TOKEN|HASS_TOKEN)(,|$)' "${P}/claude-env.log"
eq "digest: the answer is pushed with its title" "$(cat "${P}/notify.log")" "Good morning from the pins|Claude · Morning briefing"

reset
ask_fakes
touch "${P}/claude-silent"
run_digest
no_ "digest: an empty answer is not pushed" test -s "${P}/notify.log"
yes_ "digest: an empty answer is logged" grep -q "^\[cc-digest\] the briefing produced nothing (exit 0)" "${P}/digest.err"

echo "# cc-monitor"
reset
ask_fakes
touch "${P}/log-env"
run_monitor
eq "monitor: Claude is called with exactly -p and an empty tool list" \
    "$(jq -c . "${P}/claude-args.jsonl")" '["-p","--allowed-tools",""]'
yes_ "monitor: the prompt goes in on stdin and carries the log as data" grep -q PINS-LOG-MARK "${P}/claude-stdin.txt"
yes_ "monitor: Claude's environment was recorded" test -s "${P}/claude-env.log"
no_ "monitor: no Supervisor or HA credential in Claude's environment" grep -qE '(^|,)(SUPERVISOR_TOKEN|SUPERVISOR_API_TOKEN|HA_TOKEN|HASS_TOKEN)(,|$)' "${P}/claude-env.log"
eq "monitor: a finding is pushed with its title" "$(cat "${P}/notify.log")" "Good morning from the pins|Claude · HA health check"

# --- 9. a prompt API run is not counted twice ----------------------------------
# The core counts prompt runs from its audit log; agent-usage counts the console
# transcripts. A run must therefore leave no transcript: what agent-usage prints
# is the same before and after one, and the check can see a run that does.
echo "# agent-usage and prompt runs"
reset
mkfake /data/home/.local/bin/claude "${IMG}"
mkdir -p /data/home/.claude/projects/-data-workdir /data/claude-prompt/work
printf '%s\n' '{"timestamp":"2026-09-01T10:00:00Z","message":{"model":"claude-opus-5","usage":{"input_tokens":3,"output_tokens":4}}}' \
    > /data/home/.claude/projects/-data-workdir/console.jsonl
# The prompt CLI: like the real one, it saves the session unless told not to.
cat > "${P}/prompt-cli" <<'EOF'
#!/bin/bash
printf '%s\n' "$*" >> /pins/prompt-cli.log
cat > /dev/null
case " $* " in
    *" --no-session-persistence "*) ;;
    *)
        dir="${HOME}/.claude/projects/$(pwd | tr -c 'A-Za-z0-9\n' -)"
        mkdir -p "${dir}"
        printf '%s\n' '{"timestamp":"2026-09-02T10:00:00Z","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":5,"output_tokens":6}}}' >> "${dir}/run.jsonl" ;;
esac
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"ok","structured_output":{"answer":"ok"}}'
EOF
# The same CLI, reached through a wrapper that drops the flag.
cat > "${P}/prompt-cli-leaky" <<'EOF'
#!/bin/bash
args=()
for a in "$@"; do [ "${a}" = --no-session-persistence ] || args+=("${a}"); done
exec /pins/prompt-cli "${args[@]}"
EOF
chmod +x "${P}/prompt-cli" "${P}/prompt-cli-leaky"
cat > "${P}/prompt-run.js" <<'EOF'
const { run } = require('/opt/agent-console/server/prompt/run');
run({ bin: process.argv[2], cwd: '/data/claude-prompt/work', prompt: 'hello', mode: 'read', intents: [] })
  .then((outcome) => console.log(JSON.stringify(outcome)));
EOF
usage_record() {
    local out status
    out="$(env -i PATH="${BASE_PATH}" HOME=/data/home /usr/local/bin/agent-usage)"
    status=$?
    printf '%s\nexit %s\n' "${out}" "${status}"
}
prompt_run() {
    (cd /opt/agent-console && env -i PATH="${BASE_PATH}" HOME=/data/home timeout 60 /usr/local/bin/node "${P}/prompt-run.js" "$1" > "${P}/prompt-run.out" 2>&1)
}
before="$(usage_record)"
eq "agent-usage reads the console transcript" "${before}" \
    "$(printf '%s\nexit 0' '{"day": "2026-09-01", "model": "claude-opus-5", "input": 3, "output": 4, "cache_read": 0, "cache_write": 0}')"
prompt_run "${P}/prompt-cli"
yes_ "a prompt run reached the CLI with the flag" grep -q -- '--no-session-persistence' "${P}/prompt-cli.log"
eq "agent-usage is unchanged by a prompt run" "$(usage_record)" "${before}"
rm -f "${P}/prompt-cli.log"
prompt_run "${P}/prompt-cli-leaky"
yes_ "the leaky run reached the CLI without the flag" bash -c '[ -s /pins/prompt-cli.log ] && ! grep -q -- --no-session-persistence /pins/prompt-cli.log'
no_ "without the flag, agent-usage sees the run" [ "$(usage_record)" = "${before}" ]

echo
echo "behaviour pins: ${pass} passed, ${fail} failed"
[ "${fail}" -eq 0 ]
