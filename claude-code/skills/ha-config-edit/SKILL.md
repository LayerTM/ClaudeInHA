---
name: ha-config-edit
description: Safely edit Home Assistant YAML config — configuration.yaml and !include files (automations.yaml, scripts.yaml, scenes, template sensors, helpers). Use for ANY HA config change: locate the right file, back up, edit with 2-space YAML/yq, validate with `ha core check`, then reload the affected domain instead of a full restart.
---

You are inside a Home Assistant OS add-on container (Debian, root). The HA config lives in `/homeassistant`. Follow this loop for EVERY change to `configuration.yaml` or any `!include`d file (automations, scripts, template sensors, scenes, helpers). Never edit-and-restart blind.

## The safe edit loop — do not skip a step

1. **Locate** the file that actually owns the setting (respect `!include`).
2. **Back up** before any large or destructive change.
3. **Edit** with 2-space YAML (never tabs); use `yq` for programmatic edits.
4. **Validate** with `ha core check` — ALWAYS, before any reload/restart.
5. **Reload** only the affected domain. Prefer reload over a full restart.
6. **Verify** the change took effect (error log + entity state).

## 1. Locate the right file (respect !include)

`configuration.yaml` usually delegates sections to separate files. Find where:

```bash
grep -nE '!include' /homeassistant/configuration.yaml
```

Edit the INCLUDED file, not `configuration.yaml`. Common mappings:

| Directive in configuration.yaml | Edit this |
|---|---|
| `automation: !include automations.yaml` | `/homeassistant/automations.yaml` |
| `script: !include scripts.yaml` | `/homeassistant/scripts.yaml` |
| `scene: !include scenes.yaml` | `/homeassistant/scenes.yaml` |
| `!include_dir_merge_list packages/` | the matching file under that dir |

If a section is inline in `configuration.yaml` (e.g. `template:`), edit it there.

## 2. Back up before large/destructive changes

```bash
cp /homeassistant/automations.yaml /homeassistant/automations.yaml.bak   # quick per-file
ha backups new --name "pre-edit $(date +%F-%H%M)"                        # full HA snapshot
```

Never write to `/ssl` (read-only certs).

## 3. Edit (2-space YAML, use yq for programmatic changes)

`yq` (mikefarah) defaults to 2-space output — safe for HA. Append an automation to a list file:

```bash
yq -i '. += [{"id":"morning_lights","alias":"Morning lights","trigger":[{"platform":"time","at":"07:00:00"}],"action":[{"service":"light.turn_on","target":{"entity_id":"light.kitchen"}}],"mode":"single"}]' \
  /homeassistant/automations.yaml
```

Change a value in place:

```bash
yq -i '(.[] | select(.id=="morning_lights").mode) = "restart"' /homeassistant/automations.yaml
```

For hand edits, keep strict 2-space indentation and no tabs.

## 4. Validate — ALWAYS before reload/restart

```bash
ha core check
```

REST fallback if the CLI is unavailable:

```bash
curl -sS -X POST -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  http://supervisor/core/api/config/core/check_config | jq .
```

If it reports errors, fix them (or restore the `.bak`) before continuing. Do NOT restart on a failing check.

## 5. Reload the affected domain (prefer over restart)

Only after the check passes. Reload the narrowest scope that covers your change:

| Changed | Reload command (REST) |
|---|---|
| automations.yaml | `.../services/automation/reload` |
| scripts.yaml | `.../services/script/reload` |
| `template:` sensors | `.../services/template/reload` |
| scenes.yaml | `.../services/scene/reload` |
| groups | `.../services/group/reload` |
| input helpers | `.../services/input_boolean/reload` (etc.) |

```bash
curl -sS -X POST -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  http://supervisor/core/api/services/automation/reload
```

Broader YAML config reload (covers most reloadable domains at once):

```bash
ha core reload
```

Full restart is a LAST RESORT — required only for changes that are not hot-reloadable (adding a new integration, changing `homeassistant:` core keys, packages, some platforms). Validate first:

```bash
ha core check && ha core restart
```

## 6. Verify it worked

Check for new errors, then confirm the entity exists / behaves:

```bash
curl -sS -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://supervisor/core/api/error_log | tail -30
curl -sS -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  http://supervisor/core/api/states/automation.morning_lights | jq '{state, last_changed}'
```

For dashboard/Lovelace YAML changes, verify VISUALLY:

```bash
ha-shot /lovelace/0 /tmp/dash.png 1280x800   # then read the PNG
```

## Rules

- Validate (`ha core check`) before every reload/restart — no exceptions.
- Prefer domain reload > `ha core reload` > `ha core restart`.
- Back up before large/destructive edits.
- 2-space YAML, never tabs.
- Edit the `!include`d file, not `configuration.yaml`, when the section is delegated.
- Never write to `/ssl`.
