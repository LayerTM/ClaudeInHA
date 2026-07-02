---
name: ha-entity
description: Query Home Assistant entity states and call services. Use when asked "what's the state of X", to list/filter entities, to turn something on/off, set a value, or call a service.
---

Query entity states and control Home Assistant from inside the add-on container. Two access paths — use `hass-cli` if the add-on's HA Token is set, otherwise the Supervisor-proxied Core API (always available; `$SUPERVISOR_TOKEN` is always present).

## Workflow (always)

1. **Find the exact `entity_id`** first — list/filter states, never guess.
2. **Read its current state** to confirm you have the right entity.
3. **Act** — call the service with a precise target.

## Preferred: hass-cli (only when HA Token is set)

`hass-cli` works only if the add-on's Long-Lived Access Token is configured (`HASS_SERVER`/`HASS_TOKEN` set). If commands error with no server/token, fall back to the Core API below.

```bash
hass-cli state list                       # all entities
hass-cli state list | grep '^light\.'     # filter by domain
hass-cli state get light.kitchen          # one entity
hass-cli service call light.turn_on --arguments entity_id=light.kitchen,brightness_pct=60
hass-cli service call light.turn_off --arguments entity_id=light.kitchen
```

## Core API via curl + jq (always works)

Base URL `http://supervisor/core/api/`, header `Authorization: Bearer $SUPERVISOR_TOKEN`.

### List / filter states

```bash
# All entity IDs
curl -sf http://supervisor/core/api/states \
  -H "Authorization: Bearer $SUPERVISOR_TOKEN" | jq -r '.[].entity_id'

# Filter by domain or name prefix
curl -sf http://supervisor/core/api/states \
  -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  | jq -r '.[] | select(.entity_id | startswith("light.")) | .entity_id'

# entity_id + state + friendly name
curl -sf http://supervisor/core/api/states \
  -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  | jq -r '.[] | select(.entity_id|startswith("sensor.")) | "\(.entity_id)\t\(.state)\t\(.attributes.friendly_name)"'
```

### Get one entity

```bash
curl -sf http://supervisor/core/api/states/light.kitchen \
  -H "Authorization: Bearer $SUPERVISOR_TOKEN" | jq          # full object

curl -sf http://supervisor/core/api/states/light.kitchen \
  -H "Authorization: Bearer $SUPERVISOR_TOKEN" | jq -r '.state'   # just the value
```

### Call a service

POST `/services/<domain>/<service>` with a JSON body. The response is the array of states the call changed — inspect it to confirm the effect.

```bash
# Turn on with data
curl -sf -X POST http://supervisor/core/api/services/light/turn_on \
  -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id":"light.kitchen","brightness_pct":60}' | jq

# Turn off
curl -sf -X POST http://supervisor/core/api/services/light/turn_off \
  -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id":"light.kitchen"}'

# Target an area / device / label instead of an entity_id
curl -sf -X POST http://supervisor/core/api/services/light/turn_on \
  -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"target":{"area_id":"living_room"},"data":{"brightness_pct":40}}'
```

Common bodies: `switch.turn_on`/`switch.turn_off` `{"entity_id":"switch.x"}`, `climate.set_temperature` `{"entity_id":"climate.x","temperature":21}`, `homeassistant.turn_off` `{"entity_id":"<any>"}`.

## Target precisely — warning

- **Always include `entity_id` or `target`.** A service call with no target hits **every** entity in that domain (e.g. `light/turn_off` with an empty body turns off *all* lights).
- Confirm the exact `entity_id` from `/states` before acting — friendly names are not entity IDs.
- Never broaden the target beyond what was asked (no `all`, no bare-domain calls) unless the user explicitly wants every entity.
