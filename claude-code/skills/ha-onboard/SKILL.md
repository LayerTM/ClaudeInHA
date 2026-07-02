---
name: ha-onboard
description: Survey this Home Assistant instance once (version, location, entities by domain, integrations, areas, add-ons, config file layout) and record a concise orientation into /homeassistant/CLAUDE.md so future sessions start informed. Use on first contact with a new HA instance, or when the user says "get to know my setup" / "learn my Home Assistant".
---

Read-only survey. Gather facts about this Home Assistant instance, then write a tight summary into `/homeassistant/CLAUDE.md` so future sessions skip discovery. Never restart or reload during onboarding — this only reads.

First check whether onboarding already happened; if so, refresh the section instead of duplicating it:

```bash
grep -q '^# This instance' /homeassistant/CLAUDE.md 2>/dev/null && echo "ALREADY ONBOARDED — read the existing section, refresh only if stale" || echo "NOT ONBOARDED — proceed"
```

## 1. Core facts (version + location)

```bash
ha core info
curl -sS -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://supervisor/core/api/config \
  | jq '{version, location_name, time_zone, latitude, longitude, unit_system, config_dir, integrations: (.components | length)}'
```

## 2. Entities by domain

```bash
# Total entity count
curl -sS -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://supervisor/core/api/states | jq 'length'

# Count per domain, most-populated first
curl -sS -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://supervisor/core/api/states \
  | jq -r 'group_by(.entity_id | split(".")[0])
           | map({domain: (.[0].entity_id | split(".")[0]), count: length})
           | sort_by(-.count) | .[] | "\(.count)\t\(.domain)"'
```

## 3. Integrations (loaded components)

```bash
curl -sS -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://supervisor/core/api/config \
  | jq -r '.components[]' | grep -v '\.' | sort
```

## 4. Areas (optional — needs the add-on's HA Token)

```bash
# Only if HA_TOKEN is set (hass-cli configured); otherwise skip
command -v hass-cli >/dev/null && hass-cli area list 2>/dev/null || echo "areas: hass-cli unavailable (HA Token not set) — skip"
```

## 5. Add-ons

```bash
ha addons | sed -n '1,40p'   # slug / name / state; note running add-ons
```

## 6. Config file layout

```bash
ls -la /homeassistant/*.yaml
grep -nE '!include(_dir_list|_dir_merge_list|_dir_named|_dir_merge_named)?\b' /homeassistant/configuration.yaml
```

Record which files `configuration.yaml` pulls in (e.g. `automations.yaml`, `scripts.yaml`, `scenes.yaml`, and any `!include_dir_*` folders) — future edits go to the included file, not the main one.

## 7. Persist the summary

Append (or refresh) a tight, factual `# This instance` section in `/homeassistant/CLAUDE.md`. Keep it short — counts and names, not raw dumps.

```bash
cat >> /homeassistant/CLAUDE.md <<'EOF'

# This instance
_Surveyed <YYYY-MM-DD> via ha-onboard._

- **HA version:** <version> · **Location:** <location_name>, <time_zone> · **Units:** <metric/imperial>
- **Entities:** <total> total. Top domains: <light: N, sensor: N, switch: N, binary_sensor: N, ...>
- **Integrations:** <count> loaded — notable: <hue, zwave_js, mqtt, mobile_app, ...>
- **Areas:** <area1, area2, ...>  (or "not exposed / hass-cli unavailable")
- **Add-ons (running):** <slug1, slug2, ...>
- **Config layout:** `configuration.yaml` !includes <automations.yaml, scripts.yaml, ...>. Edit the included file, never inline.
- **Notes:** <anything notable — split configs, packages/, custom_components present, etc.>
EOF
```

If the section already exists, edit it in place rather than appending a second copy.

## Rules

- Survey is read-only: no `ha core restart`/`reload`, no service calls, no config edits.
- Keep the written summary tight and factual — it is orientation, not a report. No history, no speculation.
- 2-space YAML if you ever touch config; never write to `/ssl`.
- Fill every `<...>` placeholder from real command output — do not guess counts or names.
