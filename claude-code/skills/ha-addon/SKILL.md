---
name: ha-addon
description: Inspect, diagnose, and manage other Home Assistant add-ons via the Supervisor CLI. Use when asked to list/check/restart an add-on, read an add-on's logs, view its resource usage, or figure out why an add-on is failing, crashing, or unhealthy.
---

Use the `ha` (Supervisor) CLI to inspect and manage sibling add-ons. This add-on has `hassio_api` access, so `ha addons ...` commands work with no extra auth. `$SUPERVISOR_TOKEN` is always in the environment for the API fallback.

## 1. Find the slug
Add-ons are addressed by **slug** (e.g. `core_mosquitto`, `a0d7b954_nodered`), never the display name.

```bash
ha addons                 # list installed add-ons: slug, name, version, state
```

Match the user's wording to a slug from that list. For structured filtering use the Supervisor API:

```bash
curl -sS -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  http://supervisor/addons | jq '.data.addons[] | {slug, name, state, version}'
```

## 2. Inspect one add-on
```bash
ha addons info <slug>     # state, version, boot, options, url, ...
```
`state: started` = running, `stopped` = not running. The `options` block is the add-on's current configuration.

## 3. Read logs — the primary diagnostic
```bash
ha addons logs <slug>                       # recent output
ha addons logs <slug> | tail -50            # last lines
ha addons logs <slug> | grep -iE 'error|warn|traceback|fail|exception'
```
Read the tail first to see the latest state, then grep for errors/stack traces to pin the failure.

## 4. Resource usage
```bash
ha addons stats <slug>    # CPU %, memory used/limit, network + disk I/O
```
Use when an add-on is slow, was OOM-killed, or is suspected of leaking.

## 5. Restart
```bash
ha addons restart <slug>
```
Then confirm recovery:
```bash
ha addons info <slug> | grep -i state
ha addons logs <slug> | tail -30
```

## Diagnose workflow
1. `ha addons` → resolve the slug.
2. `ha addons info <slug>` → started? which version? what options?
3. `ha addons logs <slug>` → find the error at the tail.
4. If it looks config-related, review the `options` from step 2 and change the add-on's behaviour through its own configuration (UI/options), not by hand-editing its internal files.
5. `ha addons restart <slug>` → re-read the logs to confirm the fix.

## Safety
- `ha addons restart <slug>` restarts **only that add-on**. Restarting Home Assistant **Core** is a separate, heavier action — use `ha core restart` (with `ha core check` first). Do not confuse the two.
- Run `ha addons help` to discover further subcommands (e.g. start/stop/update/rebuild) instead of guessing at them.
- Never edit another add-on's internal files directly; adjust it via its configuration options.
- Do not restart or reconfigure the add-on you are running inside unless the user explicitly asks — it will drop your session.
