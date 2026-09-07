#!/usr/bin/env bash
# Seeding and migration of the add-on's own Claude Code hooks.
#
# This lives in a sourced library rather than inline in the s6 run script for one
# reason: the MIGRATION is the part that is easy to get wrong and impossible to
# notice, so it has to be testable without a container. See
# app/test/cc-hook-audit.test.sh.
#
# Why a migration is needed at all: /data persists across add-on updates, and the
# hooks block has been seeded into /data/home/.claude/settings.json since v1.4.0.
# The seed is guarded on "the user has no hooks of their own", which is false on
# every existing installation — so a change to a matcher would ship in the image
# and never reach anybody who already has the add-on. That is the same shape of
# defect as the one the audit hook itself was fixing: the code is right and
# nothing calls it.
#
# The migration therefore rewrites exactly one thing: OUR entry (the one whose
# command is the audit hook) when its matcher is still byte-for-byte one of OUR
# previous defaults. A matcher the user has touched is left alone, and so is a
# hooks config that no longer contains our hook at all. Same rule the statusLine
# block above it follows for its own superseded commands.

CC_HOOK_AUDIT_CMD=/usr/local/bin/cc-hook-audit
CC_HOOK_BACKUP_CMD=/usr/local/bin/cc-hook-backup
CC_HOOK_NOTIFY_CMD=/usr/local/bin/cc-hook-notify

# The PostToolUse matcher this version installs. `^mcp__` covers every connected
# tool server (tools arrive as mcp__<server>__<tool>).
#
# NOTE, and it is deliberate: adding `^` puts the WHOLE matcher on the regex path
# rather than the exact-list path, and that regex is unanchored — so `Bash` also
# matches `BashOutput`, `Write` also matches `TodoWrite`, and `Edit` also matches
# `NotebookEdit`. The hook is invoked for those three extra tools and writes a
# line for none of them except NotebookEdit inside the config tree, which is a
# gap this closes rather than an accident. Widening the invocation is harmless
# because the hook's own `case` uses exact literals; it is recorded here so the
# next reader does not have to rediscover it.
CC_HOOK_AUDIT_MATCHER='Bash|Edit|Write|MultiEdit|^mcp__'

# The PreToolUse (backup) matcher. Unchanged; kept here so both live in one place.
CC_HOOK_BACKUP_MATCHER='Bash|Edit|Write|MultiEdit'

# Every PostToolUse matcher this add-on has shipped before the current one, one
# per line. A matcher equal to any of these is ours to update; anything else is
# the user's.
CC_HOOK_AUDIT_SUPERSEDED_MATCHERS='Bash|Edit|Write|MultiEdit'

# hooks_seed_or_migrate <settings-file>
# Prints exactly one word: seeded | migrated | unchanged | failed
# Never removes or rewrites a hook the add-on did not install.
hooks_seed_or_migrate() {
    local sf="${1:?settings file required}"
    local tmp n

    [ -f "${sf}" ] || printf '{}\n' > "${sf}"

    # No hooks at all — a fresh install. Seed the whole block.
    if [ "$(jq -r '(.hooks // {}) | length' "${sf}" 2>/dev/null)" = "0" ]; then
        tmp="$(mktemp)" || { printf 'failed\n'; return 1; }
        if jq --arg audit "${CC_HOOK_AUDIT_MATCHER}" \
              --arg backup "${CC_HOOK_BACKUP_MATCHER}" \
              --arg audit_cmd "${CC_HOOK_AUDIT_CMD}" \
              --arg backup_cmd "${CC_HOOK_BACKUP_CMD}" \
              --arg notify_cmd "${CC_HOOK_NOTIFY_CMD}" '
                .hooks = {
                    PreToolUse:   [{matcher: $backup, hooks: [{type: "command", command: $backup_cmd}]}],
                    PostToolUse:  [{matcher: $audit,  hooks: [{type: "command", command: $audit_cmd}]}],
                    Notification: [{hooks: [{type: "command", command: $notify_cmd}]}]
                }' "${sf}" > "${tmp}" 2>/dev/null; then
            mv "${tmp}" "${sf}"
            printf 'seeded\n'
            return 0
        fi
        rm -f "${tmp}"
        printf 'failed\n'
        return 1
    fi

    # Hooks exist. Count the entries that are ours AND still on a superseded
    # matcher. Counting first, rather than diffing the file afterwards, because
    # jq reformats what it writes — a byte comparison would report a change on a
    # file that only got re-indented, and then this function would claim a
    # migration that did not happen.
    # The matcher is bound BEFORE the containment test on purpose. Piping into
    # index() rebinds `.` to the list, so `index(.matcher)` asks the LIST for a
    # .matcher field and jq errors out — which produced empty output, which this
    # function then read as "nothing to migrate". A silent no-op reporting
    # success is the exact defect this whole change exists to remove, so the exit
    # status of jq is checked too: a query that could not run is `failed`, never
    # `unchanged`.
    if ! n="$(jq -r --arg old "${CC_HOOK_AUDIT_SUPERSEDED_MATCHERS}" --arg cmd "${CC_HOOK_AUDIT_CMD}" '
            ($old | split("\n")) as $superseded
            | ((.hooks.PostToolUse // []) | if type == "array" then . else [] end)
            | map((.matcher // "") as $m
                  | select(((.hooks // []) | any(.command == $cmd))
                           and (($superseded | index($m)) != null)))
            | length' "${sf}" 2>/dev/null)"; then
        printf 'failed\n'
        return 1
    fi
    case "${n}" in
        '') printf 'failed\n'; return 1 ;;
        0)  printf 'unchanged\n'; return 0 ;;
    esac

    tmp="$(mktemp)" || { printf 'failed\n'; return 1; }
    if jq --arg cur "${CC_HOOK_AUDIT_MATCHER}" \
          --arg old "${CC_HOOK_AUDIT_SUPERSEDED_MATCHERS}" \
          --arg cmd "${CC_HOOK_AUDIT_CMD}" '
            ($old | split("\n")) as $superseded
            | .hooks.PostToolUse |= map(
                (.matcher // "") as $m
                | if ((.hooks // []) | any(.command == $cmd))
                     and (($superseded | index($m)) != null)
                  then .matcher = $cur
                  else . end)' "${sf}" > "${tmp}" 2>/dev/null; then
        mv "${tmp}" "${sf}"
        printf 'migrated\n'
        return 0
    fi
    rm -f "${tmp}"
    printf 'failed\n'
    return 1
}
