---
name: ha-energy
description: Analyse Home Assistant energy and power usage — find energy/power sensors, read the Energy dashboard config, and summarise consumption, cost, and top consumers over a period. Use when asked about power draw, kWh, the electricity bill/cost, what's using the most energy, or energy trends.
---

Answer energy questions with numbers, not guesses: **find the sensors → learn what HA actually tracks (Energy dashboard) → measure over a period → rank the consumers.**

Set the Supervisor-proxied Core API shorthand (the token is always present, no HA Token needed):

```bash
API=http://supervisor/core/api
AUTH="Authorization: Bearer $SUPERVISOR_TOKEN"
```

## 1. Find the energy & power sensors

Two device classes matter: `power` (instantaneous, **W**/**kW**) and `energy` (cumulative, **Wh**/**kWh**). Energy meters you can subtract over time usually have `state_class: total_increasing`.

```bash
# Cumulative energy meters (kWh) — usable for consumption over a period
curl -sS -H "$AUTH" "$API/states" | jq -r '
  .[] | select(.attributes.device_class=="energy")
  | "\(.entity_id)\t\(.state) \(.attributes.unit_of_measurement)\t\(.attributes.state_class)\t\(.attributes.friendly_name)"'

# Instantaneous power sensors (W/kW)
curl -sS -H "$AUTH" "$API/states" | jq -r '
  .[] | select(.attributes.device_class=="power")
  | "\(.entity_id)\t\(.state) \(.attributes.unit_of_measurement)\t\(.attributes.friendly_name)"'
```

Catch anything mislabelled by unit alone:

```bash
curl -sS -H "$AUTH" "$API/states" | jq -r '
  .[] | select((.attributes.unit_of_measurement // "") | test("^(k?Wh|k?W)$"))
  | "\(.entity_id)\t\(.state) \(.attributes.unit_of_measurement)"'
```

## 2. Read the Energy dashboard config (what HA really tracks)

The Energy dashboard preferences are **not exposed on the REST API** — read them from HA's storage (mounted at `/homeassistant`). This is the always-works path and tells you the exact grid/solar/battery/gas stats and per-device meters the dashboard uses.

```bash
jq '.data' /homeassistant/.storage/energy          # full config
```

Pull out the configured statistic entities:

```bash
# Grid / solar / battery / gas source sensors
jq -r '.data.energy_sources[] | .type as $t
  | ((.flow_from[]?.stat_energy_from), (.flow_to[]?.stat_energy_to),
     .stat_energy_from, .stat_energy_to) // empty
  | select(.!=null) | "\($t)\t\(.)"' /homeassistant/.storage/energy

# Cost sensors (device_class monetary)
jq -r '.data.energy_sources[] | .. | objects | .stat_cost? // empty' /homeassistant/.storage/energy

# Individual devices tracked on the dashboard
jq -r '.data.device_consumption[] | "\(.stat_consumption)\t\(.name // "")"' /homeassistant/.storage/energy
```

## 3. Right now — who's drawing the most power

Instant snapshot, no history needed — sort every power sensor by current watts:

```bash
curl -sS -H "$AUTH" "$API/states" | jq -r '
  [ .[] | select(.attributes.device_class=="power")
    | {n:(.attributes.friendly_name // .entity_id), w:(.state|tonumber?)} ]
  | map(select(.w!=null)) | sort_by(-.w) | .[] | "\(.w) W\t\(.n)"'
```

## 4. Consumption & cost over a period (history API)

`GET /api/history/period/<start_iso>` returns state changes from `<start>` to now (add `end_time=` to bound it). Response is an **array of arrays** — one inner array of states per entity, in time order. For a `total_increasing` energy (or monetary cost) sensor, consumption over the window is simply **last value − first value**.

```bash
START=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)
E=sensor.home_energy_total     # a kWh total_increasing sensor

curl -sS -G -H "$AUTH" \
  --data-urlencode "filter_entity_id=$E" \
  --data-urlencode "minimal_response" \
  "$API/history/period/$START" \
| jq -r '.[0] | (map(.state|tonumber?)) as $v
   | if ($v|length)>1 then "\((($v[-1]-$v[0])*100|round)/100) over the period" else "no numeric history" end'
```

Bound a specific window (e.g. yesterday) and reuse the same delta for a cost sensor:

```bash
START=$(date -u -d 'yesterday 00:00' +%Y-%m-%dT%H:%M:%SZ)
END=$(date -u -d 'today 00:00'       +%Y-%m-%dT%H:%M:%SZ)

curl -sS -G -H "$AUTH" \
  --data-urlencode "filter_entity_id=sensor.electricity_cost" \
  --data-urlencode "end_time=$END" \
  --data-urlencode "minimal_response" \
  "$API/history/period/$START" \
| jq -r '.[0] | (map(.state|tonumber?)) as $v | ($v[-1]-$v[0])'
```

`minimal_response` slims the payload while keeping `entity_id`/attributes on the first element of each series. You can pass several IDs at once: `filter_entity_id=sensor.a,sensor.b`.

## 5. Top consumers over a period

Feed the Energy dashboard's per-device meters (from step 2) straight into one history call, compute each device's kWh delta, and rank:

```bash
START=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)
IDS=$(jq -r '[.data.device_consumption[].stat_consumption] | join(",")' /homeassistant/.storage/energy)

curl -sS -G -H "$AUTH" \
  --data-urlencode "filter_entity_id=$IDS" \
  --data-urlencode "minimal_response" \
  "$API/history/period/$START" \
| jq -r '
    map( select(length>0)
      | (map(.state|tonumber?)) as $v
      | { name:(.[0].attributes.friendly_name // .[0].entity_id),
          kwh:(if ($v|length)>1 then ($v[-1]-$v[0]) else 0 end) } )
    | sort_by(-.kwh) | .[]
    | "\((.kwh*100|round)/100) kWh\t\(.name)"'
```

No per-device meters configured? Swap `$IDS` for the energy sensors found in step 1.

## 6. Trend — this period vs last

Compare two equal windows to say "up/down X%":

```bash
now_kwh () {   # kWh consumed by $1 between $2 and $3 (ISO, Z)
  curl -sS -G -H "$AUTH" \
    --data-urlencode "filter_entity_id=$1" \
    --data-urlencode "end_time=$3" \
    --data-urlencode "minimal_response" \
    "$API/history/period/$2" \
  | jq -r '.[0] | (map(.state|tonumber?)) as $v | ($v[-1]-$v[0]) // 0'
}
E=sensor.home_energy_total
T0=$(date -u -d 'today 00:00'      +%Y-%m-%dT%H:%M:%SZ)
T1=$(date -u -d 'yesterday 00:00'  +%Y-%m-%dT%H:%M:%SZ)
T2=$(date -u -d '2 days ago 00:00' +%Y-%m-%dT%H:%M:%SZ)
echo "today:     $(now_kwh $E $T0 $(date -u +%Y-%m-%dT%H:%M:%SZ)) kWh"
echo "yesterday: $(now_kwh $E $T1 $T0) kWh"
```

## Notes & caveats

- **Meter resets:** a `total_increasing` sensor resets to 0 on device reboot, so last−first can go negative or undercount if it reset mid-window. For a suspicious result, eyeball the raw series (`jq '.[0]|map(.state)'`) and use a window without a reset, or split it.
- **`unknown`/`unavailable`** states are dropped by `tonumber?` automatically — good, but a gap means the device was offline for part of the window.
- **Exact dashboard figures:** the Energy dashboard reads HA's *long-term statistics* (hourly aggregates), which are **WebSocket-only** (`recorder/statistics_during_period`, `energy/get_prefs`) and not on the REST API. The history-delta method above is a close, always-available approximation via `$SUPERVISOR_TOKEN`. If the add-on's **HA Token** is set, `hass-cli` and a WebSocket client can fetch the precise statistics; otherwise stick with the curl approach here.
- **Cost** works identically — point the delta at the `stat_cost` (monetary) sensors from step 2.
