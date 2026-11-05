#!/usr/bin/env bash
# The one place that reads and writes Claude Code's settings.json for the add-on.
#
# Two facts, each stated once:
#
# 1. An EMPTY file is not a settings file with something to protect. After a
#    power cut the file can be zero bytes long (the rename reached the disk, the
#    data did not). jq reads such a file as "no input", prints nothing and exits
#    0, so a writer that trusts jq's status reports success or `failed` and the
#    file stays empty for good. settings_file_ready turns a missing, empty or
#    whitespace-only file into `{}`; a file that holds anything else but is not
#    a JSON object may be the user's work and is NEVER touched.
#
# 2. A write replaces the file whole or not at all. The new content is built
#    beside the target (same directory, so the final mv is a rename, not a copy
#    across filesystems), must be a non-empty JSON object, and is flushed to
#    disk before the rename.
#
# Sourced by addon-hooks.sh, addon-statusline.sh and engine-hooks.sh;
# tested in app/test/settings-file.test.sh.

# settings_file_ready <file>
# Exit 0: the file is a JSON object (created or repaired when it was missing,
# empty or whitespace-only). Exit 1: it holds something else — left as it is.
settings_file_ready() {
    local file="${1:?settings file required}"
    if [ ! -e "${file}" ] || ! grep -q '[^[:space:]]' "${file}" 2>/dev/null; then
        # No content to lose: write the empty object by the same atomic route.
        _settings_file_replace "${file}" '{}' || return 1
        return 0
    fi
    jq -e 'type == "object"' "${file}" >/dev/null 2>&1 || return 1
}

# settings_file_edit <file> <jq args...>
# Runs jq with the given arguments over the file and replaces the file with the
# result. Refuses (exit 1, file untouched) when the file is not a JSON object,
# jq fails, or its output is not a non-empty JSON object.
settings_file_edit() {
    local file="${1:?settings file required}"
    shift
    settings_file_ready "${file}" || return 1
    local out
    out="$(jq "$@" "${file}" 2>/dev/null)" || return 1
    _settings_file_replace "${file}" "${out}"
}

# _settings_file_replace <file> <json text>
_settings_file_replace() {
    local file="${1:?}" text="${2-}" tmp
    [ -n "${text}" ] || return 1
    printf '%s' "${text}" | jq -e 'type == "object"' >/dev/null 2>&1 || return 1
    tmp="$(mktemp "${file}.XXXXXX")" || return 1
    if printf '%s\n' "${text}" > "${tmp}" \
        && { sync "${tmp}" 2>/dev/null || sync; } \
        && mv "${tmp}" "${file}"; then
        return 0
    fi
    rm -f "${tmp}"
    return 1
}
