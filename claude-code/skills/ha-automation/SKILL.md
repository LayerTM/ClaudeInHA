---
name: ha-automation
description: Create or modify Home Assistant automations and scripts. Use when the user wants to automate behavior ("when X happens, do Y"), schedule something, or edit/fix an existing automation or script.
---

# Home Assistant Automations & Scripts

Create and edit automations/scripts by editing YAML in `/homeassistant`, validating, then reloading (no restart needed).

## Workflow (always in this order)

1. **Find the target file.** Check `/homeassistant/configuration.yaml` for includes:
   - `automation: !include automations.yaml` → edit `/homeassistant/automations.yaml`
   - `script: !include scripts.yaml` → edit `/homeassistant/scripts.yaml`
   - `!include_dir_merge_list automations/` → add/edit a file inside that dir.
   - **Edit the included file, never inline into `configuration.yaml`.** If no include exists and automations are defined inline, edit them where they are.
2. **Discover entity_ids** you'll reference (don't guess names):
   ```bash
   curl -s -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://supervisor/core/api/states \
     | yq -p=json '.[].entity_id' | grep -i light
   # or, if HA Token is set:  hass-cli state list | grep -i light
   ```
3. **Edit YAML.** 2-space indent, never tabs. Use `yq` for programmatic edits, or write the block directly.
4. **Validate — ALWAYS before applying:**
   ```bash
   ha core check
   ```
   Fix any error before continuing.
5. **Apply with reload (preferred over restart):**
   ```bash
   curl -sX POST -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
     http://supervisor/core/api/services/automation/reload
   # scripts:  .../services/script/reload
   ```
   `automation.reload` re-reads all automations (picks up new ones too). Only `ha core restart` if a reload can't apply the change (e.g. new integration/platform).
6. **Back up before large or destructive edits:** `ha backups new --name pre-automation-edit`.

## Automation schema

`automations.yaml` is a **YAML list**. Each entry:

| Key | Notes |
|-----|-------|
| `id` | Unique, stable string. Required for UI editing & tracking. Use a descriptive slug. |
| `alias` | Human-readable name. Make it descriptive. |
| `description` | Optional, one line of intent. |
| `triggers` | What fires it (older configs use `trigger:`; both work). |
| `conditions` | Optional gate; all must be true (older: `condition:`). |
| `actions` | What to do (older: `action:`). |
| `mode` | `single` (default), `restart`, `queued`, or `parallel`. |

Newer HA also renamed `service:` → `action:` inside action steps; both are accepted. Match the style already in the file.

## Common triggers

```yaml
triggers:
  - trigger: state          # entity changes state
    entity_id: binary_sensor.front_door
    to: "on"
    for: "00:00:30"         # optional debounce
  - trigger: time           # absolute time
    at: "07:00:00"
  - trigger: time_pattern   # e.g. every 5 minutes
    minutes: "/5"
  - trigger: sun            # sunset/sunrise
    event: sunset
    offset: "-00:15:00"
  - trigger: numeric_state
    entity_id: sensor.temperature
    above: 25
  - trigger: mqtt
    topic: home/button/press
  - trigger: template
    value_template: "{{ states('sensor.power') | float > 3000 }}"
```

## Common actions

```yaml
actions:
  - action: light.turn_on         # service call
    target:
      entity_id: light.porch
    data:
      brightness_pct: 60
  - delay: "00:05:00"
  - if:                            # conditional
      - condition: state
        entity_id: person.alex
        state: home
    then:
      - action: notify.mobile_app_alex
        data: { message: "Welcome home" }
  - choose:                        # multi-branch
      - conditions:
          - condition: numeric_state
            entity_id: sensor.temperature
            below: 18
        sequence:
          - action: climate.set_temperature
            target: { entity_id: climate.living }
            data: { temperature: 21 }
    default:
      - action: climate.turn_off
        target: { entity_id: climate.living }
```

## Concrete example — full automation

Append to `/homeassistant/automations.yaml`:

```yaml
- id: porch_light_on_at_sunset
  alias: Porch light on at sunset
  description: Turn on the porch light 15 min before sunset, off at 23:00
  triggers:
    - trigger: sun
      event: sunset
      offset: "-00:15:00"
    - trigger: time
      at: "23:00:00"
  actions:
    - choose:
        - conditions:
            - condition: trigger
              id: null   # or use trigger.event to branch; simplest: split into two automations
          sequence: []
    - action: >-
        {{ 'light.turn_off' if now().hour >= 23 else 'light.turn_on' }}
      target:
        entity_id: light.porch
  mode: single
```

For clarity, prefer two focused automations (one for sunset-on, one for 23:00-off) over branching — descriptive and easier to debug.

## Script schema

`scripts.yaml` is a **YAML dict** keyed by the script's slug (the slug becomes `script.<slug>`):

```yaml
goodnight:
  alias: Goodnight routine
  sequence:
    - action: light.turn_off
      target: { entity_id: all }
    - action: lock.lock
      target: { entity_id: lock.front_door }
  mode: single
```

Run it later with service `script.goodnight` or `script.turn_on` targeting `script.goodnight`.

## Guardrails

- `ha core check` **before** any reload/restart — non-negotiable.
- Prefer reload over restart; back up before large/destructive edits.
- 2-space YAML, never tabs. Never write to `/ssl`.
- Give every automation a stable `id` and a descriptive `alias`.
- Test after reload: check `curl -s -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://supervisor/core/api/states/automation.<id>` shows the new entity, and read `ha core check` / `GET /error_log` if it misbehaves.
