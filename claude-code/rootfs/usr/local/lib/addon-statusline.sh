#!/usr/bin/env bash
# Seeding and migration of Claude Code's statusLine setting.
#
# A sourced library rather than inline in the s6 run script so the migration can
# be tested without a container — see app/test/cc-statusline.test.sh. Same reason
# and same rule as addon-hooks.sh: /data persists across add-on updates, so a
# change made only to the seed reaches nobody who already has the add-on.
#
# The statusLine is ours when its command is the width-aware wrapper, or one of
# the commands earlier versions installed. Anything else is the user's and is
# never touched.

CC_STATUSLINE_CMD=/usr/local/bin/cc-statusline-width

# Earlier defaults, one per line: the 1.2.x cc-statusline script and the
# 1.43–1.46 bare ccstatusline command.
CC_STATUSLINE_SUPERSEDED_CMDS='/usr/local/bin/cc-statusline
/usr/local/bin/ccstatusline'

# Seconds between re-runs of the status line command.
#
# Claude Code re-runs the status line only on events (a turn, a mode, model or
# effort change) and a terminal resize is not one of them. Claude starts with the
# add-on, inside a tmux session no browser has attached to yet, so its first
# status line is drawn for tmux's default 80 columns and ccstatusline's
# "full-minus-40" leaves 40 — which then stayed on screen, cut off, until the
# first event, however wide the console was. The interval bounds how long a
# stale width can survive.
#
# It is polling, and it costs one ccstatusline run per tick for as long as Claude
# runs, console open or not. Measured on an Apple-silicon VM with 4 vCPUs: about
# 0.13 s of CPU per run, so 30 s is about 0.4 % of one core. A slower board pays
# proportionally more. A user who sets their own refreshInterval keeps it.
CC_STATUSLINE_REFRESH=30

# Seed or migrate the statusLine in the given settings.json.
# Prints exactly one of: seeded | migrated | unchanged | failed.
statusline_seed_or_migrate() {
    local sf="${1:?settings file required}"
    local state tmp

    [ -f "${sf}" ] || printf '{}\n' > "${sf}"

    # Classify first, then write. A jq that could not run is `failed`, never
    # `unchanged`: an empty answer must not read as "nothing to do".
    if ! state="$(jq -r --arg cmd "${CC_STATUSLINE_CMD}" \
                        --arg old "${CC_STATUSLINE_SUPERSEDED_CMDS}" '
            ($old | split("\n")) as $superseded
            | (.statusLine // null) as $sl
            | if $sl == null then "absent"
              elif ($sl | type) != "object" then "foreign"
              elif (($sl.command // "") as $c | $superseded | index($c)) != null then "superseded"
              elif ($sl.command // "") == "" then "absent"
              elif $sl.command == $cmd and ($sl | has("refreshInterval") | not) then "no-interval"
              else "current"
              end' "${sf}" 2>/dev/null)"; then
        printf 'failed\n'
        return 1
    fi

    case "${state}" in
        absent | superseded)
            tmp="$(mktemp)" || { printf 'failed\n'; return 1; }
            if jq --arg cmd "${CC_STATUSLINE_CMD}" --argjson every "${CC_STATUSLINE_REFRESH}" \
                  '.statusLine = {type: "command", command: $cmd, padding: 0, refreshInterval: $every}' \
                  "${sf}" > "${tmp}" 2>/dev/null; then
                mv "${tmp}" "${sf}"
                if [ "${state}" = absent ]; then printf 'seeded\n'; else printf 'migrated\n'; fi
                return 0
            fi
            rm -f "${tmp}"
            printf 'failed\n'
            return 1 ;;
        no-interval)
            # Our wrapper, installed before the interval existed. Add only the
            # interval; padding and anything else in the object stay as they are.
            tmp="$(mktemp)" || { printf 'failed\n'; return 1; }
            if jq --argjson every "${CC_STATUSLINE_REFRESH}" '.statusLine.refreshInterval = $every' \
                  "${sf}" > "${tmp}" 2>/dev/null; then
                mv "${tmp}" "${sf}"
                printf 'migrated\n'
                return 0
            fi
            rm -f "${tmp}"
            printf 'failed\n'
            return 1 ;;
        current | foreign)
            printf 'unchanged\n'
            return 0 ;;
        *)
            printf 'failed\n'
            return 1 ;;
    esac
}
