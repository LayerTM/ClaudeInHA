---
name: ha-blueprint
description: Import and use Home Assistant blueprints — reusable automation/script templates. Use when asked to import a blueprint from a URL, list installed blueprints, or build an automation from a blueprint (use_blueprint).
---

A **blueprint** is a reusable automation or script template: someone defines the logic once with named **inputs** (which sensor, which light, which delay), and you create concrete automations from it by filling those inputs — no copy-pasting YAML.

Blueprints live as YAML files under, by domain:

| Path | For |
|---|---|
| `/homeassistant/blueprints/automation/<author>/<name>.yaml` | automation blueprints |
| `/homeassistant/blueprints/script/<author>/<name>.yaml` | script blueprints |

Shorthand for the Supervisor-proxied Core API (token is always present):

```bash
API=http://supervisor/core/api
AUTH="Authorization: Bearer $SUPERVISOR_TOKEN"
```

## 1. Import a blueprint from a URL

There is no REST import service (the UI's "Import Blueprint" is a WebSocket/frontend action). The CLI-native, always-works path is: fetch the **raw** blueprint YAML and drop it into the right directory.

```bash
# author = a folder slug you choose to keep sources tidy
mkdir -p /homeassistant/blueprints/automation/community
curl -sSL "https://raw.githubusercontent.com/<user>/<repo>/main/motion_light.yaml" \
  -o /homeassistant/blueprints/automation/community/motion_light.yaml
```

- A GitHub **blob** URL (`.../blob/main/x.yaml`) is an HTML page, not YAML — convert it to raw: `.../blob/` → `raw.githubusercontent.com/.../` (drop `/blob`). Or just click **Raw** on GitHub and copy that URL.
- A **community.home-assistant.io** forum URL isn't raw YAML (it's a page with a code block). Easiest there: paste it into HA's UI (**Settings → Automations & Scenes → Blueprints → Import Blueprint**), which scrapes the code block for you. Then continue from step 4 to use it.

Confirm you actually fetched a blueprint (it must have a `blueprint:` block with a matching `domain:`):

```bash
yq '.blueprint | {name, domain}' \
  /homeassistant/blueprints/automation/community/motion_light.yaml
```

A minimal blueprint looks like this — inputs are declared under `blueprint.input` and referenced with `!input`:

```yaml
blueprint:
  name: Motion-activated Light
  description: Turn a light on when motion is detected.
  domain: automation
  input:
    motion_entity:
      name: Motion Sensor
      selector:
        entity: { domain: binary_sensor, device_class: motion }
    light_target:
      name: Light
      selector:
        target: { entity: { domain: light } }
trigger:
  - platform: state
    entity_id: !input motion_entity
    to: "on"
action:
  - service: light.turn_on
    target: !input light_target
mode: single
```

## 2. List installed blueprints

```bash
find /homeassistant/blueprints -name '*.yaml' | sort           # all
find /homeassistant/blueprints/automation -name '*.yaml'       # automation blueprints only
```

The `path` you'll reference next is the file location **relative to `blueprints/automation/`** (or `blueprints/script/`) — here that's `community/motion_light.yaml`.

## 3. See what inputs a blueprint expects

```bash
yq '.blueprint.input' \
  /homeassistant/blueprints/automation/community/motion_light.yaml
```

Every key here is an input you supply in the next step. Match them exactly.

## 4. Create an automation FROM the blueprint

Instead of `trigger`/`action`, a blueprint-based automation has a `use_blueprint:` block: the `path` (relative, from step 2) plus one entry per input. Append it to your automations file — if `configuration.yaml` uses `!include automations.yaml`, edit that **included** file, 2-space indent, never tabs:

```yaml
- id: "1700000000000"
  alias: Hallway motion light
  use_blueprint:
    path: community/motion_light.yaml
    input:
      motion_entity: binary_sensor.hallway_motion
      light_target:
        entity_id: light.hallway
```

Use real entity IDs — confirm them from `/states` first (`ha-state binary_sensor.` / `ha-state light.`) rather than guessing. Script blueprints work the same way inside `scripts.yaml`.

## 5. Reload

Validate, then reload the consuming domain (no restart needed):

```bash
ha core check                                              # MUST pass first

curl -sS -X POST -H "$AUTH" "$API/services/automation/reload"   # for automations
curl -sS -X POST -H "$AUTH" "$API/services/script/reload"       # for scripts
```

Editing or re-importing a blueprint itself doesn't take effect until you reload the automations/scripts that use it.

## 6. Verify

Confirm the new automation entity exists, is on, and points at the blueprint:

```bash
curl -sS -H "$AUTH" "$API/states/automation.hallway_motion_light" \
  | jq '{state, last_triggered: .attributes.last_triggered}'
```

Then trigger it and watch the target react:

```bash
curl -sS -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"entity_id":"automation.hallway_motion_light"}' \
  "$API/services/automation/trigger"
```

If reload failed, the blueprint or inputs are wrong — re-check `ha core check` output and the error log (`curl -sS -H "$AUTH" "$API/error_log" | tail -n 40`) for the automation ID or a missing/misnamed input.

> Optional (only if the add-on's **HA Token** is set): `hass-cli` can call the same reload — `hass-cli service call automation.reload`. The `$SUPERVISOR_TOKEN` curl path above always works without it.
