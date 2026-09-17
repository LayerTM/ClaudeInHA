#!/usr/bin/env bash
# The Claude Code engine for the core's start script and provisioning
# (/usr/local/bin/addon-run, /usr/local/bin/provision-extras): its paths and
# the steps only Claude needs. The core sources this file and calls the
# functions in its own order; see the core's README for what each one is for.
# The add-on's names are in /opt/agent-console/adapter/branding.json.
# shellcheck shell=bash disable=SC2034

# Shared helpers for the settings seeded into /data/home/.claude/settings.json.
# shellcheck source=addon-hooks.sh
source /usr/local/lib/addon-hooks.sh
# shellcheck source=addon-statusline.sh
source /usr/local/lib/addon-statusline.sh

# The Claude binary is installed to /root/.local at build time and copied to
# /data/home/.local so login state, sessions and updates survive restarts.
ENGINE_BIN_DIR=/data/home/.local/bin
ENGINE_PROMPT_BIN=/data/home/.local/bin/claude
ENGINE_INSTRUCTIONS_SOURCE=/usr/share/claude-ha/CLAUDE.md
ENGINE_INSTRUCTIONS_FILE=CLAUDE.md
ENGINE_STATE_DIR=/data/home/.claude
ENGINE_SKILLS_DIR=/data/home/.claude/skills

# --- Persistent HOME ---
engine_prepare_home() {
    if [ ! -d /data/home/.local ]; then
        bashio::log.info "First run — setting up persistent home directory..."
        cp -a /root/.local /data/home/.local
    fi

    # Guarantee the persistent binary actually RUNS on this image. /data survives
    # add-on updates, so an upgrade that changes the base libc (e.g. the Alpine→
    # Debian move: a musl binary left in /data can't run on glibc → "cannot execute:
    # required file not found") must re-seed the binary from the current image.
    # Preserves ~/.claude (auth/sessions) — only ~/.local (the binary) is replaced.
    if ! /data/home/.local/bin/claude --version >/dev/null 2>&1; then
        bashio::log.warning "Persistent Claude binary is missing or incompatible with this image — reinstalling from the image (login/sessions are kept)"
        rm -rf /data/home/.local
        cp -a /root/.local /data/home/.local
    fi
}

engine_env() {
    export USE_BUILTIN_RIPGREP=0
    # Claude refuses --dangerously-skip-permissions under root unless it detects
    # a sandbox; the add-on container is one.
    export IS_SANDBOX=1
}

# --- Sync Claude binary from image if newer ---
# After an add-on image rebuild the bundled Claude may be newer than the
# persistent copy; sync so image upgrades actually deliver the newer binary.
engine_sync_from_image() {
    local image_bin="/root/.local/bin/claude"
    local persistent_bin="/data/home/.local/bin/claude"

    [ -x "${image_bin}" ] || return 0
    [ -x "${persistent_bin}" ] || return 0

    local image_v persistent_v newer
    image_v=$("${image_bin}" --version 2>/dev/null | awk '{print $1}') || image_v=""
    persistent_v=$("${persistent_bin}" --version 2>/dev/null | awk '{print $1}') || persistent_v=""

    if [ -z "${image_v}" ] || [ -z "${persistent_v}" ]; then
        bashio::log.warning "Could not determine Claude version for binary sync"
        return 0
    fi

    if [ "${image_v}" = "${persistent_v}" ]; then
        bashio::log.info "Claude Code version: ${persistent_v}"
        return 0
    fi

    newer=$(printf '%s\n%s\n' "${image_v}" "${persistent_v}" | sort -V | tail -n1)

    if [ "${newer}" = "${image_v}" ]; then
        bashio::log.info "Image has newer Claude (${image_v} > ${persistent_v}) — syncing to persistent storage"
        rm -rf /data/home/.local/share/claude
        mkdir -p /data/home/.local/share
        cp -a /root/.local/share/claude /data/home/.local/share/ 2>/dev/null || true
        cp -af "${image_bin}" "${persistent_bin}"
    else
        bashio::log.info "Persistent Claude (${persistent_v}) is newer than image (${image_v}) — keeping persistent"
    fi
}

# --- Authentication ---
#   1. ANTHROPIC_API_KEY       — API key from console.anthropic.com
#   2. CLAUDE_CODE_OAUTH_TOKEN — long-lived token from `claude setup-token`
#   3. Interactive /login in the terminal (persists in /data/home/.claude)
engine_auth() {
    local api_key oauth_token
    api_key=$(bashio::config 'api_key')
    oauth_token=$(bashio::config 'oauth_token')

    if bashio::var.has_value "${api_key}"; then
        export ANTHROPIC_API_KEY="${api_key}"
        bashio::log.info "Anthropic API key configured"
    fi

    if bashio::var.has_value "${oauth_token}"; then
        export CLAUDE_CODE_OAUTH_TOKEN="${oauth_token}"
        bashio::log.info "CLAUDE_CODE_OAUTH_TOKEN configured"
    fi

    if ! bashio::var.has_value "${api_key}" && ! bashio::var.has_value "${oauth_token}"; then
        bashio::log.notice "No api_key or oauth_token set — log in from the Claude tab (run 'claude' and follow the URL) or use a token from 'claude setup-token'"
    fi
}

# --- Model override ---
engine_model() {
    local model
    model=$(bashio::config 'model')
    if bashio::var.has_value "${model}"; then
        export ANTHROPIC_MODEL="${model}"
        bashio::log.info "Model override: ${model}"
    fi
}

# --- Auto-update on startup ---
engine_update() {
    bashio::log.info "Checking for Claude Code updates..."
    /data/home/.local/bin/claude update 2>&1 \
        || bashio::log.warning "Update check failed (non-critical)"
}

engine_update_disabled() {
    export DISABLE_AUTOUPDATER=1
    bashio::log.info "Auto-update disabled"
}

# --- Skills directory, status line and safety hooks ---
engine_provision() {
    mkdir -p "${ENGINE_SKILLS_DIR}"

    # Rich status line (ccstatusline — the same tool desktop Claude Code uses).
    # Seed the bundled ccstatusline config into the persistent home and point
    # Claude's statusLine at the bundled ccstatusline binary. Both are seeded only
    # when absent, so any user customisation is never overwritten.
    local cc_cfg_dir=/data/home/.config/ccstatusline
    mkdir -p "${cc_cfg_dir}"
    if [ ! -f "${cc_cfg_dir}/settings.json" ]; then
        cp /usr/share/claude-ha/ccstatusline-settings.json "${cc_cfg_dir}/settings.json" \
            && bashio::log.info "Status line config seeded (ccstatusline)"
    fi

    local settings_file=/data/home/.claude/settings.json
    [ -f "${settings_file}" ] || echo '{}' > "${settings_file}"
    # Seeded when absent; our own earlier defaults are migrated to the width-aware
    # wrapper, and a wrapper installed before the refresh interval existed gets the
    # interval. A user's own command is left untouched — see addon-statusline.sh.
    # The helpers print one word and fail only together with `failed`, which is
    # reported here rather than ending the start.
    local outcome
    outcome="$(statusline_seed_or_migrate "${settings_file}")" || true
    case "${outcome}" in
        seeded)   bashio::log.info "Status line configured (ccstatusline, width-aware)" ;;
        migrated) bashio::log.info "Status line updated (redrawn every ${CC_STATUSLINE_REFRESH} s, so it follows the console width)" ;;
        failed)   bashio::log.warning "Could not write the status line into ${settings_file} — leaving it as it is" ;;
    esac

    # Safety hooks: backup-before-risky-change, action audit log, needs-input push.
    # Seeded on a fresh install; on an existing one, only OUR own superseded matcher
    # is updated and anything the user has touched is left alone. /data survives an
    # update, so a seed-only guard would ship a matcher change to nobody who already
    # has the add-on — see addon-hooks.sh for why that is worth a migration.
    # cc-hook-notify is a no-op unless HA_NOTIFY_SERVICE is set.
    outcome="$(hooks_seed_or_migrate "${settings_file}")" || true
    case "${outcome}" in
        seeded)   bashio::log.info "Safety hooks configured (backup / audit / notify)" ;;
        migrated) bashio::log.info "Safety hooks updated (audit log now covers connected tool servers)" ;;
        failed)   bashio::log.warning "Could not write the safety hooks into ${settings_file} — leaving it as it is" ;;
    esac
}

engine_console_env() {
    REMOTE_CONTROL=$(jq -r '.remote_control // false' /data/options.json 2>/dev/null || echo false)
    export REMOTE_CONTROL
}

# Chat runs read no settings files, so the audit hook the console gets from
# settings.json is handed to them explicitly — built from the same definition.
engine_prompt_settings() {
    hooks_audit_settings_json
}

# --- Provisioning (provision-extras) ---

# Marketplaces + plugins (base + the add-on's `marketplaces` / `plugins` options).
engine_provision_plugins() {
    BASE_MARKETPLACES=(anthropics/claude-plugins-official anthropics/skills)
    BASE_PLUGINS=(
        superpowers@claude-plugins-official
        frontend-design@claude-plugins-official
        skill-creator@claude-plugins-official
        security-guidance@claude-plugins-official
        context7@claude-plugins-official
        code-review@claude-plugins-official
        code-simplifier@claude-plugins-official
        feature-dev@claude-plugins-official
        commit-commands@claude-plugins-official
        claude-md-management@claude-plugins-official
        hookify@claude-plugins-official
        document-skills@anthropic-agent-skills
    )

    # User additions (newline-separated env from the service)
    mapfile -t USER_MARKETPLACES < <(printf '%s\n' "${CC_USER_MARKETPLACES:-}" | sed '/^$/d')
    mapfile -t USER_PLUGINS < <(printf '%s\n' "${CC_USER_PLUGINS:-}" | sed '/^$/d')

    installed_marketplaces="$(claude plugin marketplace list 2>/dev/null || true)"
    for mp in "${BASE_MARKETPLACES[@]}" "${USER_MARKETPLACES[@]}"; do
        [ -n "${mp}" ] || continue
        # Match the source in parentheses ("… (owner/repo)" / "… (https://…)") so a
        # slug that is a substring of another marketplace's does not false-match.
        if ! grep -qF "(${mp})" <<<"${installed_marketplaces}"; then
            log "adding marketplace ${mp}"
            claude plugin marketplace add "${mp}" >/dev/null 2>&1 \
                && log "  ok ${mp}" || log "  FAILED ${mp} (will retry next start)"
        fi
    done

    installed_plugins="$(claude plugin list 2>/dev/null || true)"
    for pl in "${BASE_PLUGINS[@]}" "${USER_PLUGINS[@]}"; do
        [ -n "${pl}" ] || continue
        name="${pl%@*}"
        if ! grep -qE "^\s*❯?\s*${name}@" <<<"${installed_plugins}"; then
            log "installing plugin ${pl}"
            claude plugin install "${pl}" >/dev/null 2>&1 \
                && log "  ok ${pl}" || log "  FAILED ${pl} (will retry next start)"
        fi
    done
}

# MCP servers in user scope (avoids the project workspace-trust prompt).
engine_mcp_has() { claude mcp list 2>/dev/null | grep -qE "(^|\s)${1}(\s|:|$)"; }

# engine_mcp_add NAME [KEY=VALUE...] -- ARGV...
engine_mcp_add() {
    local name="$1" env_args=()
    shift
    while [ "$#" -gt 0 ] && [ "$1" != -- ]; do
        env_args+=(-e "$1")
        shift
    done
    shift
    claude mcp add "${name}" -s user "${env_args[@]}" -- "$@"
}
