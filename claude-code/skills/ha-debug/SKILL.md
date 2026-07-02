---
name: ha-debug
description: Investigate a misbehaving Home Assistant entity, integration, or automation. Use when the user says something in HA isn't working, is erroring, not updating, is unavailable, or stopped responding — pulls errors, inspects state, forms a hypothesis, applies a fix, and verifies.
---

Work systematically and evidence-first. Do NOT propose a fix before you have logs + state in hand. Order every investigation: **evidence → inspect → reproduce → hypothesis → fix → verify.**

Set a shorthand for the Supervisor-proxied Core API (the token is always present):

```bash
API=http://supervisor/core/api
AUTH="Authorization: Bearer $SUPERVISOR_TOKEN"
```

## 1. Pull recent errors first

```bash
curl -sS -H "$AUTH" "$API/error_log" | tail -n 80
```

Grep it for the entity, domain, or integration in question:

```bash
curl -sS -H "$AUTH" "$API/error_log" | grep -iE 'error|warning|traceback|<domain>'
```

Then read the log at the correct layer:

```bash
ha core logs            # HA Core: integrations, automations, templates
ha addons logs <slug>   # a specific add-on (use `ha addons` to list slugs)
```

## 2. Inspect the entity — state + attributes

```bash
curl -sS -H "$AUTH" "$API/states/<entity_id>" | jq .
```

Read the signals:
- `state` = `unavailable` → the integration/device isn't providing it (offline, auth failure, network, IP change).
- `state` = `unknown` → set up but no value yet.
- attribute `restored: true` → HA restored it from its DB; the integration did NOT re-create it this boot, i.e. it failed to load (go to steps 1 and 4).
- Missing/wrong attributes → bad platform config or a template error (check the log).

## 3. Check for staleness

```bash
curl -sS -H "$AUTH" "$API/states/<entity_id>" | jq '{state, last_changed, last_updated}'
```

Compare `last_updated` to now. If it should be moving but isn't → the source (poll/push/webhook) stopped. `last_changed` frozen while `last_updated` advances = value is genuinely unchanged and updates ARE flowing (not stuck).

## 4. Check the integration / config entry

- The `entity_id` domain (e.g. `sensor.`, `light.`) plus the device identify the owning integration. Re-grep the error log (step 1) for that integration for setup failures, auth errors, or timeouts.
- List config entries and their state:

```bash
jq '.data.entries[] | {domain, title, state, disabled_by}' \
  /homeassistant/.storage/core.config_entries
```

  `state: loaded` is healthy; `setup_error` / `setup_retry` points straight at the failing integration.
- Confirm Core itself is healthy: `ha core info`.

## 5. Reproduce

Force the pathway and watch the result change:

```bash
# fire an automation manually:
curl -sS -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"entity_id":"automation.<name>"}' "$API/services/automation/trigger"
```

For an automation that "won't fire", verify the trigger entity's ACTUAL state (step 2) against the trigger condition — mismatched casing/values (`'on'` vs `'On'`, `'home'`) are common. Check the automation entity's `last_triggered` and `current` attributes.

## 6. Form a hypothesis

State it in one line, tied to evidence. E.g. "sensor is `unavailable` and log shows `ConnectTimeout` → device offline / IP changed" or "automation never fires because trigger uses `to: 'on'` but the binary_sensor reports `'off'` unchanged."

## 7. Apply the fix — safely

- Editing YAML? 2-space indent, never tabs. If `configuration.yaml` uses `!include automations.yaml`, edit the **included** file, not the main one. Use `yq` for surgical edits. Never write to `/ssl`.
- Back up before destructive/large edits: `ha backups new --name pre-debug-<entity>` (or copy the file first).
- **Validate before any restart:** `ha core check` (it MUST pass).
- **Prefer reload over restart:**

```bash
curl -sS -X POST -H "$AUTH" "$API/services/automation/reload"     # automations
curl -sS -X POST -H "$AUTH" "$API/services/script/reload"         # scripts
curl -sS -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"entity_id":"<entity_id>"}' \
  "$API/services/homeassistant/reload_config_entry"               # one integration entry
```

  Use `ha core reload` for YAML config that supports it; only `ha core restart` when nothing lighter can apply the change (and only after `ha core check` passes).

## 8. Verify the fix

- Re-query state; confirm it's no longer `unavailable`/stale and `last_updated` advances:

```bash
curl -sS -H "$AUTH" "$API/states/<entity_id>" | jq '{state, last_updated}'
```

- Confirm the error is gone: re-run step 1 and expect no new tracebacks.
- UI/dashboard change? Screenshot and look at it:

```bash
ha-shot /lovelace/0 /tmp/verify.png 1280x800
```

  Then Read the PNG to confirm visually. (If `ha-shot` prints a token hint, the add-on's HA Token isn't set.)

Report back: symptom → evidence → root cause → fix applied → verification result.
