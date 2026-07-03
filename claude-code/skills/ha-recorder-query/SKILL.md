---
name: ha-recorder-query
description: Query a Home Assistant sensor's history and trends from the recorder — pull a time series for an entity and compute its min / max / average / trend. Use when asked how a value changed over time, its high/low/average over a period, or whether it's trending up or down.

---

Read a numeric entity's past values out of the HA **recorder** (the history database) and reduce the series to min/max/avg/trend with `jq`. The reliable, always-available path is the Supervisor-proxied Core API with `$SUPERVISOR_TOKEN` — no HA Token needed.

Set shorthands and a time window (GNU `date` is available; timestamps must be timezone-aware ISO 8601):

```bash
API=http://supervisor/core/api
AUTH="Authorization: Bearer $SUPERVISOR_TOKEN"
START=$(date -u -d '1 day ago' --iso-8601=seconds)   # e.g. 2026-07-02T12:00:00+00:00
END=$(date -u --iso-8601=seconds)
```

For other windows: `date -u -d '6 hours ago' --iso-8601=seconds`, `'7 days ago'`, `'2026-07-01T00:00:00+00:00'` (pass a literal). Omitting the start entirely (`GET /history/period`) defaults to **1 day ago**.

## 1. Pull the history series

`GET /history/period/<start>?filter_entity_id=<entity_id>`. The start timestamp is a **path** segment; everything else is query params. The response is an **array of arrays** — one inner array per entity (in the order listed), each a list of state points `{entity_id, state, last_changed, last_updated, attributes}`.

```bash
# Raw time,value series for one entity over the window
curl -sf -G "$API/history/period/$START" -H "$AUTH" \
  --data-urlencode "filter_entity_id=sensor.living_room_temperature" \
  --data-urlencode "end_time=$END" \
  --data-urlencode "minimal_response" \
  | jq -r '.[0][] | "\(.last_changed)\t\(.state)"'
```

Multiple entities: comma-separate them — `filter_entity_id=sensor.a,sensor.b` — then index `.[0]`, `.[1]`, … per entity.

## 2. Compute min / max / avg

States can be `unavailable` / `unknown`; `tonumber?` silently drops any non-numeric point so the math stays clean:

```bash
curl -sf -G "$API/history/period/$START" -H "$AUTH" \
  --data-urlencode "filter_entity_id=sensor.living_room_temperature" \
  --data-urlencode "end_time=$END" \
  --data-urlencode "minimal_response" \
  | jq '[ .[0][] | .state | tonumber? ]
        | { count: length,
            min:   min,
            max:   max,
            avg:   (if length>0 then (add/length) else null end) }'
```

## 3. Trend (first vs last, delta)

```bash
curl -sf -G "$API/history/period/$START" -H "$AUTH" \
  --data-urlencode "filter_entity_id=sensor.living_room_temperature" \
  --data-urlencode "minimal_response" \
  | jq -r '[ .[0][] | { t: .last_changed, v: (.state|tonumber?) } ]
           | "first=\(.[0].v)  last=\(.[-1].v)  delta=\(.[-1].v - .[0].v)  points=\(length)"'
```

Positive `delta` = rising over the window, negative = falling. For a coarse rate, divide `delta` by the elapsed hours.

## 4. Trim the payload

Big windows or chatty sensors return a lot. Narrow with these valueless flag params (send them bare via `--data-urlencode "<flag>"`):

| Param | Effect |
|---|---|
| `filter_entity_id=<id[,id…]>` | Restrict to specific entities — **always set this** |
| `minimal_response` | Drop attributes on all but the first/last point of each entity (state + `last_changed` kept — enough for the jq above) |
| `significant_changes_only` | Skip points that aren't a significant change (fewer rows) |
| `no_attributes` | Omit attributes entirely |
| `end_time=<ISO8601>` | Upper bound of the window (default: now) |

## Long-term statistics (beyond retention)

For entities with a `state_class` (energy, temperature, …) HA also keeps **long-term statistics** — hourly/5-min `mean`/`min`/`max`/`sum` that survive the recorder purge. These are **not** on the REST API; they're only reachable over the WebSocket API command `recorder/statistics_during_period`. If you need aggregated data older than retention and have a WebSocket client (e.g. `websocat`):

```bash
{ echo '{"type":"auth","access_token":"'"$SUPERVISOR_TOKEN"'"}'
  echo '{"id":1,"type":"recorder/statistics_during_period","start_time":"'"$START"'","statistic_ids":["sensor.living_room_temperature"],"period":"hour"}'
  sleep 2; } | websocat -n ws://supervisor/core/websocket | jq -c 'select(.id==1) | .result'
```

For anything within retention, prefer the `history/period` curl above — it's simpler and always available.

## Caveats

- **Retention window.** The recorder keeps only the last `purge_keep_days` (default **10 days**) of raw history. Ask for older raw data and you'll get an empty/short series — use long-term statistics instead.
- **Entity must be recorded.** If the `recorder:` config `exclude`s the entity/domain (or the recorder is disabled), there is no history at all. An empty `.[0]` means "not recorded", not "no changes".
- **Non-numeric states.** `unavailable` / `unknown` gaps are normal; the `tonumber?` filter above drops them. An empty result after filtering means the series had no numeric values in range.
- **Timestamps.** Must be timezone-aware ISO 8601 (the `--iso-8601=seconds` helper handles this); a naive `2026-07-01` will be rejected or misinterpreted.
- **Optional HA Token path.** If the add-on's HA Token is set you can hit the same endpoint directly at `$HA_URL/api/history/period/...` with `Authorization: Bearer $HA_TOKEN` — but the Supervisor path above needs no extra setup.
