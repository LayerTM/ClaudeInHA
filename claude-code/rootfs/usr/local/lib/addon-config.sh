#!/usr/bin/env bash
# Shared config readers for the add-on's shell entrypoints.
#
# `bashio::config` must NOT be used for a list-type option. Its last statement
# is `printf "%s" "${result}"` — no trailing newline — which strips the newline
# jq produced, and `while IFS= read -r` silently discards a final line that is
# not newline-terminated. Measured in this add-on's own base image
# (ghcr.io/hassio-addons/debian-base:9.3.0):
#
#   one-entry list  -> the loop body runs ZERO times, with no output at all:
#                      no "Custom env:", and not even the malformed-entry warning
#   two-entry list  -> the last entry is silently dropped
#
# It also fetches the configuration from the Supervisor API rather than from
# disk, so a hiccup there produces exactly the same silence.
#
# options.json is the single source of config truth for these scripts. Scalars
# already read it directly (ha_token, upload_retention_days, remote_control);
# this is the list form of the same rule.
#
# Reported as ClaudeInHA#51 (environment_vars); the same defect silently
# truncated init_commands and extra_args.

# config_list <key> [options_file]
# Emits one newline-terminated line per entry. Empty output for an absent key,
# an empty list, or an unreadable file.
config_list() {
    jq -r --arg key "${1}" '(.[$key] // [])[]' "${2:-/data/options.json}" 2>/dev/null
}
