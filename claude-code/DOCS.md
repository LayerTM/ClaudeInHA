# Claude Code — Home Assistant Add-on

Runs the full [Claude Code CLI](https://code.claude.com/docs) inside Home Assistant, presented as a web console in the sidebar. Claude has direct access to your HA configuration and APIs: it can create automations, debug integrations, run shell commands, and manage your setup through conversation.

## Installation

1. **Settings → Add-ons → Add-on Store** → ⋮ → **Repositories** → add
   `https://github.com/LayerTM/ClaudeInHA`
2. Install **Claude Code** and start it.
3. Open the **Claude Code** sidebar panel.

## Authentication (pick one)

| Method | How |
|---|---|
| **Subscription (recommended)** | Leave both fields empty, open the console, run `claude` and follow the login URL. The login persists across restarts. |
| **OAuth token** | On any machine run `claude setup-token`, paste the printed token into **OAuth Token**. No interactive login needed. Note: this token type does not support Remote Control. |
| **API key** | Paste a key from [console.anthropic.com](https://console.anthropic.com) into **API Key**. Pay-per-use. |

## The console

- **Tabs** — ✳ Claude plus any number of shell tabs (+). Exiting Claude shows a restart menu; the session never dies with it.
- **Copy** — hold a modifier and drag to select, and it copies automatically: **Option+drag on macOS**, **Shift+drag on Windows/Linux/ChromeOS** (a real terminal selection). Or press **Cmd+C** / **Ctrl+Shift+C** / **Ctrl+Insert** for the current selection (plain Ctrl+C still interrupts the running program; Ctrl+Insert is the safest on desktop Chrome, where Ctrl+Shift+C also opens DevTools). A wrapped line copies as one line, and it works even over plain HTTP. Without the modifier, a drag goes through tmux and lands in the 📥 tray instead. The ⧉ menu copies the visible screen / recent output / full history without selecting — **this is the copy path on phones**, where text selection isn't available. If the browser blocks clipboard access entirely, copies land in the 📥 tray — tap an entry to copy it. The mouse **wheel scrolls** the history.
- **Paste** — Ctrl+Shift+V / Cmd+V, or the 📋 button.
- **Find** — Cmd+F (macOS) or Ctrl+Shift+F, or the 🔍 button, opens a search bar to find text anywhere in the scrollback; Enter / Shift+Enter step through matches, Esc closes it. On phones, tap 🔍 on the key bar. (Plain Ctrl+F is left for the shell/TUI — it's forward-char in the shell and page-forward in less/vim.)
- **Attach files & images** — drag & drop anywhere, paste an image from the clipboard, or use 📎 (opens camera/gallery on phones). The file is saved under `/data/uploads` and its path is typed into the prompt.
- **Update Claude** — ⬆ button, or `update-claude` in a shell tab (`update-claude 2.1.150` installs a specific version). Only the Claude session restarts; the add-on keeps running. With **Auto-Update** enabled the CLI also updates at every add-on start.
- **Mobile** — a key bar (Esc, Tab, arrows, ^C…) appears on touch devices; ⛶ hides the HA chrome for a full-screen terminal.

## Home Assistant tooling (built in)

Everything Claude needs to work with Home Assistant is preinstalled — no
per-session setup:

| Tool | Use |
|---|---|
| `ha` | Supervisor CLI: `ha core check`, `ha core reload`, `ha addons`, `ha backups new --name X` |
| `ha-check` | Validate the HA configuration (run before any restart) |
| `ha-state [entity\|domain.]` | Query entity states, e.g. `ha-state light.kitchen`, `ha-state light.` |
| `ha-shot <path> [out.png] [WxH]` | Screenshot a Lovelace dashboard to PNG, e.g. `ha-shot /lovelace/0 /tmp/d.png 1280x800` (needs **HA Token**) |
| `ha-usage [days]` | Summarize Claude token usage (today / N days / all-time, per model) and prompt-API cost |
| `yq` | Edit YAML config files |
| `hass-cli` | Entity/service queries (needs **HA Token**) |
| Playwright MCP | Browser automation tools; Chromium is preinstalled |

A **Home Assistant skill pack** is bundled: `/ha-config-edit`, `/ha-automation`,
`/ha-debug`, `/ha-entity`, `/ha-screenshot`, `/ha-backup`, `/ha-addon`,
`/ha-onboard`. General plugins are bundled too (superpowers, frontend-design,
skill-creator, security-guidance, context7, code-review, code-simplifier,
feature-dev, commit-commands, claude-md-management, hookify, document-skills).
All of it lives in `/data/home/.claude` and **persists across add-on updates**;
provisioning runs once in the background (see `/data/provision.log`).

Add your own with the `plugins`, `marketplaces`, and `skills_git` options —
reconciled on every start.

## Configuration options

| Option | Purpose |
|---|---|
| `api_key` / `oauth_token` | Authentication (see above). Stored encrypted by the Supervisor. |
| `ha_token` | A Home Assistant Long-Lived Access Token (Profile → Security). Enables dashboard screenshots, `hass-cli`, `hass-mcp`, and WebSocket/REST access as you. Persists across updates. Optional. |
| `bypass_permissions` | Start Claude with `--dangerously-skip-permissions` (fully autonomous). |
| `auto_update` | Update the CLI at every add-on start. Manual `update-claude` always works. |
| `model` | Model override, e.g. `claude-sonnet-4-6`. |
| `custom_instructions` | Text appended to the built-in HA context (CLAUDE.md). |
| `environment_vars` | Extra env vars, `KEY=VALUE` per entry. |
| `init_commands` | Shell commands run at startup (install tools, MCP servers). |
| `plugins` | Extra plugins to install, `name@marketplace` per entry. |
| `marketplaces` | Extra plugin marketplaces (GitHub `owner/repo`, URL, or path). |
| `skills_git` | Git repo of your own skills, synced into `~/.claude/skills` each start. |
| `extra_args` | Extra `claude` CLI arguments, one per entry. |
| `launch_command` | Full replacement for the default `claude` invocation. |
| `upload_retention_days` | Auto-delete attached files after N days (0 = keep). |
| `remote_control` | Adds a tab running `claude remote-control`: drive this session from the Claude mobile app / claude.ai. Requires a full `/login` (subscription); `oauth_token` and API keys are not sufficient. |
| `monitoring_interval_hours` | Opt-in proactive monitoring: every N hours Claude reviews the error log and config and notifies you only if it finds something (0 = off). |
| `proactive_alerts` + `alert_*` | Opt-in **deterministic** anomaly alerts (no Claude, no plan usage): notify on a water leak, door/window open at night, low battery, temperature out of band, high CO2, humidity out of band, or a watched device/internet gateway going offline. See *Proactive alerts* below. |
| `prompt_api` | Serve the secure Prompt API for the companion **Claude** (`claude_ha`) integration (on by default). See *The companion integration* below. |
| `api_token` | Optional fixed bearer token for the Prompt API. Leave empty — the add-on generates one and hands it to the integration via discovery. |
| `prompt_ha_token` | Optional HA token used only by Prompt-API sessions to read state through the MCP Server integration. Best practice: a dedicated non-admin user's token. Falls back to `ha_token`. |

## Claude in Home Assistant

Claude works in `/homeassistant` (your config) with `/share`, `/media`, `/ssl`, `/backup` mounted. The Supervisor API is available via `$SUPERVISOR_TOKEN`:

```bash
curl -sS -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  http://supervisor/core/api/states | jq '.[].entity_id'
```

The bundled `CLAUDE.md` teaches Claude the HA API, config patterns, and safety rules (validate config before restart, prefer reloads, and so on).

MCP servers, skills, and plugins work exactly as in the desktop CLI: `.mcp.json` in `/homeassistant`, skills under `/data/home/.claude/skills/`, `claude plugin install <name>`.

## Proactive alerts

Set `proactive_alerts: true` for opt-in, **deterministic** anomaly alerts. Unlike
proactive monitoring (`monitoring_interval_hours`) and the morning digest, this
uses **no Claude call and no plan usage** — it is a small bash + jq loop that
fetches your Home Assistant states every `proactive_alerts_interval_minutes`
(default 15) and applies fixed rules. Because there is no model, there is no
prompt-injection surface.

It watches for:

- **Water leak** (`alert_water_leak`, on) — any `moisture`/leak sensor turning on. **Critical**: always sent, even during quiet hours.
- **Open at night** (`alert_open_at_night`, on) — a door, window, garage, or opening left `on` during the night window (`alert_night_start`–`alert_night_end`, default 23:00–06:00).
- **Low battery** (`alert_battery_below`, default 15%; 0 = off) — any `battery` entity below the threshold.
- **Temperature out of band** (`alert_temp_enabled`, off by default) — a `temperature` sensor below `alert_temp_low` (5) or above `alert_temp_high` (45). Off by default because sensible bands vary. By default it checks **every** `temperature` sensor — including device temperatures (a NAS or switch CPU running at 45–75°), which would false-trigger. Set `alert_temp_entities` to a list of just your **room** temperature sensors to scope the check to those (see below).
- **High CO2** (`alert_co2_above`, default 1400 ppm; 0 = off) — any `carbon_dioxide` sensor reading above the threshold, so you know when a room needs airing out. Non-critical (held back during quiet hours).
- **Humidity out of band** (`alert_humidity_enabled`, off by default) — a `humidity` sensor below `alert_humidity_low` (25%) or above `alert_humidity_high` (70%), so you catch a damp bathroom/cellar or over-dry room. Non-critical (held back during quiet hours).
- **Offline / network** (`alert_offline`, on) — any entity you list in `alert_offline_entities` that reports `unavailable`/`unknown`, or (for a `device_tracker`) `not_home`. **Critical**: always sent, even during quiet hours. Defaults to watching your internet gateway (`device_tracker.ucg_fiber`), so "the internet/router is down" is caught out of the box.

**Dedupe:** you are notified only when an entity *newly* enters an anomaly. A
still-open door won't re-notify every cycle — the active anomalies are remembered
in `/data/alerts-state.json` and dropped when they clear, so the same entity can
alert again the next time the problem reappears.

**Quiet hours** (`alert_quiet_hours`, e.g. `22:00-07:00`, empty = off): during
this window non-critical alerts (battery, temperature, open-at-night, high CO2)
are held back and stay pending until quiet hours end; critical alerts — water
leak and a watched device going offline — are **always** sent.

All new anomalies from one cycle are batched into a single notification titled
*Claude · Home alert*. As with the monitor and digest, set `HA_NOTIFY_SERVICE`
in Environment Variables to push to your phone; otherwise it lands in the HA
notification bell. Activity is logged to `/data/alerts.log`.

### Adding, changing, or removing an alert

Every alert is just an option you set in the add-on's **Configuration** tab — no
automations and no code. Because the whole feature is deterministic (fixed bash +
jq rules, no model), it costs **nothing in plan usage** and has **no
prompt-injection surface**. First turn the feature on with `proactive_alerts:
true`, then enable, disable, or tune each check:

| Alert | Option(s) | Turn off | Tune |
|-------|-----------|----------|------|
| Water leak | `alert_water_leak` | `false` | — (critical, always sent) |
| Open at night | `alert_open_at_night`, `alert_night_start`, `alert_night_end` | `alert_open_at_night: false` | change the night window |
| Low battery | `alert_battery_below` | `0` | raise/lower the % threshold |
| Temperature | `alert_temp_enabled`, `alert_temp_low`, `alert_temp_high`, `alert_temp_entities` | `alert_temp_enabled: false` | set your low/high band; scope to specific sensors with `alert_temp_entities` |
| High CO2 | `alert_co2_above` | `0` | set the ppm threshold (default 1400) |
| Humidity | `alert_humidity_enabled`, `alert_humidity_low`, `alert_humidity_high` | `alert_humidity_enabled: false` | set your low/high %RH band |
| Offline / network | `alert_offline`, `alert_offline_entities` | `alert_offline: false` | edit the watched-entity list |

**Adding a device to the offline watch.** To be alerted when a critical device
drops off — your NAS, a camera, a second router — add its `entity_id` to
`alert_offline_entities`:

```yaml
alert_offline_entities:
  - device_tracker.ucg_fiber   # your internet gateway (the default)
  - sensor.nas_status
  - camera.front_door
```

Any listed entity that reports `unavailable` or `unknown` — or, for a
`device_tracker`, `not_home` — raises a critical *Offline: …* alert. For a
`device_tracker`, watch **always-present infrastructure** (a gateway, NAS, or
camera) — avoid a person's phone tracker, or you'll get an *Offline* alert every
time they leave home. **To remove** a watched device, delete its line (keep the gateway if you still want
internet-down detection, or set `alert_offline: false` to switch the whole check
off). Setting `alert_offline_entities: []` (an explicit empty list) while leaving
`alert_offline: true` watches **nothing** — an explicit way to disable offline
alerts without turning `alert_offline` off (an *absent* list, by contrast, falls
back to watching the default gateway). Changes take effect on the next cycle (within
`proactive_alerts_interval_minutes`) — just save the options, no restart needed.

**Scoping the temperature check.** The temperature alert checks every
`temperature` sensor by default, which includes **device** temperatures — a NAS,
a switch, or a CPU sensor happily running at 45–75° — that would trip a false
*Temperature out of range* alert. List just your **room** temperature sensors in
`alert_temp_entities` to check only those:

```yaml
alert_temp_entities:
  - sensor.living_room_temperature
  - sensor.bedroom_temperature
```

When the list is non-empty, only the entities on it are checked; every other
temperature sensor (including device temps) is ignored. Leave it empty (or unset)
to keep the legacy behaviour of checking **all** temperature sensors.

## The companion integration (Prompt API)

A separate Home Assistant integration, **Claude** (`claude_ha`), lets you talk to
Claude from **Assist** (text and voice) and from a `claude.ask` service in
automations — without opening the console. It talks to this add-on over a
dedicated, locked-down HTTP endpoint called the **Prompt API**.

The Prompt API is designed for running Claude on **untrusted input** (whatever a
chat message or automation sends) with limited Home Assistant access, so it is
deliberately much more restricted than the interactive console:

- **Separate internal port (8126), never published to the host.** It is reachable
  only from Home Assistant's internal network; requests from anywhere else are
  refused.
- **Bearer token on every request** (constant-time checked). The add-on generates
  the token and shares it with the integration automatically through Supervisor
  discovery — you configure nothing.
- **Each prompt runs a fresh, stateless, read-only Claude** with deny-by-default
  permissions: shell, file, and web tools are removed entirely, and the child
  process gets **none** of your Supervisor or Home Assistant credentials in its
  environment. Home Assistant access, when enabled, is only through the
  **Model Context Protocol Server** integration, so Claude can see and touch
  **only the entities you have exposed to Assist**.
- **Actions require confirmation, and the confirmed action is executed from the
  validated request only.** A read request that would change state returns a
  *proposal* rather than acting; the integration asks you to confirm; only then
  is a second, tightly-scoped call allowed to perform exactly that action — and
  that call is driven solely by the validated intent, never by the original
  free-form message, so untrusted text never reaches the state-changing path.
- Rate-limited, concurrency-capped, time-bounded, output-capped, and
  secret-redacted; every call is written to the audit log (`ha-audit`).
- **Its own model — optionally faster for voice.** The companion chat can run a
  different model from the interactive console (`chat_model`) — e.g. a quicker,
  cheaper one for snappy Assist replies — and spoken (voice) turns can use an even
  faster model (`chat_model_voice`), since voice answers are short and lower
  latency matters more there than raw capability. Both are optional; leave them
  empty to use the console's model. Replies are also written in your Home
  Assistant language, and voice replies are kept to one short, spoken-friendly
  sentence.

### Manage automations by chatting

With the companion integration you can **create, edit, and delete automations** by
describing them in plain language to Assist (text or voice) — no YAML, no editor:

- *"Create an automation that turns on the porch light at sunset."*
- *"Change my porch-light automation to come on at 21:00."*
- *"Delete my porch-light automation."*

Claude drafts the automation (or the edit) and shows it to you; **nothing is
written until you confirm** (yes/no). Safety is built in: before saving, the
integration re-validates the configuration against Home Assistant's own automation
schema and permits only a safe set of service calls — it refuses code execution
(`shell_command`, `python_script`) and payloads that could reach arbitrary
devices, so a drafted automation can only do ordinary household things. An edit
preserves the parts you didn't ask to change; a delete always asks first and, when
more than one automation matches, asks which — it never removes an ambiguous one.

To use it, install the `claude_ha` integration (it will detect this add-on
automatically) and, for live HA context, install Home Assistant's *Model Context
Protocol Server* integration and set `prompt_ha_token`. To turn the endpoint off
entirely, set `prompt_api` to false.

## Persistence

Everything that matters lives in `/data` and survives restarts and updates: login and sessions (`/data/home/.claude`), the CLI binary (`/data/home/.local`), uploads (`/data/uploads`). Resume the last conversation with `claude --resume` or the `c` option in the exit menu.

## Troubleshooting

- **Blank screen** — check the add-on log; restart the add-on.
- **401 / frozen after long idle** — the ingress session expires after 15 minutes without traffic; the console reloads automatically, or refresh the page.
- **Copy does not reach the clipboard** — rare now (selecting text copies in the pointer gesture, which works over plain HTTP too). If a browser blocks the clipboard even inside a gesture, the text is still saved to the 📥 tray — one tap to copy — and serving HA over HTTPS avoids it entirely.
- **`bypass_permissions` refuses to start** — the add-on sets `IS_SANDBOX=1` automatically; if a CLI update ever breaks this, run `claude install <previous-version> --force` in a shell tab and report an issue.

## Support

Issues: [github.com/LayerTM/ClaudeInHA](https://github.com/LayerTM/ClaudeInHA/issues)
