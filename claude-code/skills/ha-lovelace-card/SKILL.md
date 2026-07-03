---
name: ha-lovelace-card
description: Design a Home Assistant Lovelace dashboard card or view and preview it live. Use when the user wants to build, add, or tweak a dashboard card (entities/glance/gauge/history-graph/custom) and see how it looks — write the card YAML, screenshot it with ha-shot, read the PNG, and iterate until it looks right.

---

Build a Lovelace card by iterating against a real screenshot — never hand a user card YAML you have not *seen* render. The whole loop: **write the card → `ha-shot` → Read the PNG → adjust → repeat.**

Set a shorthand for the Supervisor-proxied Core API (the token is always present):

```bash
API=http://supervisor/core/api
AUTH="Authorization: Bearer $SUPERVISOR_TOKEN"
```

## 1. Use real entities

Cards that reference non-existent entities render as errors. Find the exact `entity_id`s first:

```bash
ha-state sensor.          # list a domain
ha-state light.living_room   # confirm one entity + its attributes
```

Or via the API: `curl -sf -H "$AUTH" "$API/states" | jq -r '.[].entity_id'`.

## 2. Where dashboards live — pick the right file to edit

| Mode | Config location | How it updates |
|---|---|---|
| **Storage** (default; "edit in the UI") | `/homeassistant/.storage/lovelace` (default dash), `/homeassistant/.storage/lovelace.<url_path>` (extra dashes), `.storage/lovelace_resources` (custom-card JS) | Cached in memory. Edit via the UI raw-config editor (live). A direct file edit only takes effect after a **Core restart** — avoid. |
| **YAML** | default: `/homeassistant/ui-lovelace.yaml` (needs `lovelace: mode: yaml`); extra: files under `/homeassistant/dashboards/` declared in `configuration.yaml` | **Re-read on every fresh page load.** `ha-shot` launches a new browser each run, so the file is re-read every screenshot — no restart between iterations. |

**For AI-driven iteration, use a YAML-mode dashboard** — it is file-owned and re-read on each shot, so the loop below has zero restarts. Do not hand-edit `.storage/lovelace*`.

### One-time scratch dashboard (keeps your real dashboards untouched)

Add to `/homeassistant/configuration.yaml` (2-space indent, never tabs; `url_path` must contain a hyphen):

```yaml
lovelace:
  dashboards:
    lovelace-scratch:
      mode: yaml
      title: Scratch
      icon: mdi:flask
      show_in_sidebar: true
      filename: dashboards/scratch.yaml
```

Then validate and restart once (adding a dashboard is read at startup, so it needs a restart — later card edits do not):

```bash
ha core check && ha core restart
```

Give it a starting view at `/homeassistant/dashboards/scratch.yaml`:

```yaml
title: Scratch
views:
  - title: Preview
    path: preview
    cards:
      - type: entities
        title: Living Room
        entities:
          - light.living_room
          - sensor.living_room_temperature
```

It now lives at path `/lovelace-scratch/0`.

## 3. Compose the card

Drop these under a view's `cards:` (or into `scratch.yaml`). Swap in your real `entity_id`s.

```yaml
# entities — the workhorse list card
- type: entities
  title: Living Room
  show_header_toggle: false
  entities:
    - entity: light.living_room
    - entity: sensor.living_room_temperature
      name: Temperature
    - entity: switch.fan
      secondary_info: last-changed
```

```yaml
# glance — compact icon grid
- type: glance
  title: At a glance
  columns: 3
  entities:
    - sensor.living_room_temperature
    - sensor.living_room_humidity
    - binary_sensor.front_door
```

```yaml
# gauge — single numeric sensor with severity bands
- type: gauge
  entity: sensor.cpu_temperature
  name: CPU
  unit: "°C"
  min: 20
  max: 90
  needle: true
  severity: { green: 20, yellow: 65, red: 80 }
```

```yaml
# history-graph — trend over time
- type: history-graph
  title: Last 24h
  hours_to_show: 24
  entities:
    - sensor.living_room_temperature
    - sensor.living_room_humidity
```

Combine cards with `vertical-stack` / `horizontal-stack`, and pull in a **custom** card by `type: custom:<name>`:

```yaml
- type: vertical-stack
  cards:
    - type: gauge
      entity: sensor.living_room_temperature
      name: Temp
    - type: custom:mini-graph-card    # requires the JS resource registered
      entities: [sensor.living_room_temperature]
      hours_to_show: 24
```

Custom cards render blank/error until their JS **resource** is registered — in YAML mode add it under `lovelace: resources:` (`- url: /local/mini-graph-card.js` `type: module`); in storage mode via Settings → Dashboards → Resources. Prefer built-in card types unless the user needs a custom one.

## 4. The feedback loop — shot → read → adjust

Screenshot the dashboard path, then **Read the PNG** to actually judge it:

```bash
ha-shot /lovelace-scratch/0 /tmp/card.png 1280x800   # then Read /tmp/card.png
ha-shot /lovelace-scratch/0 /tmp/card.png 414x896    # mobile-width check
```

- Look at: does the card render (no red error box), right entities, sensible layout, labels/units, empty/`unavailable` states.
- Adjust the YAML, re-run the **same** `ha-shot` to the **same** file, Read it again. Repeat until it matches the goal.
- A screenshot you don't Read proves nothing — always look.

Interactive states `ha-shot` can't reach (open a dialog, hover, toggle, wait for data)? Use the Playwright MCP: `browser_navigate` → `http://homeassistant:8123/lovelace-scratch/0`, then `browser_take_screenshot` and Read the PNG.

## 5. Ship it

Once it looks right, move the finished card into the user's real dashboard:
- **YAML mode:** paste into `ui-lovelace.yaml` / the dashboard file, `ha core check`, shot to confirm.
- **Storage mode:** give the user the YAML to paste via the dashboard's ⋮ → *Edit dashboard* → *Raw configuration editor* (do not write `.storage/lovelace` by hand).

## Rules
- 2-space YAML, never tabs. Reference only entities you confirmed in step 1.
- Iterate on a **YAML-mode** dashboard so each `ha-shot` re-reads the file with no restart.
- `ha-shot` failing with a token hint → the add-on's **HA Token** option is unset; tell the user to set it (Profile → Security → Long-lived access tokens), don't guess at the result.
- Never claim a card "looks good" without a fresh PNG you actually Read.

*(Optional nicety: if the HA Token is set, `hass-cli state list` also lists entities for step 1 — but `ha-state`/the Core API above always work.)*
