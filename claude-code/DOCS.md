# Claude Code — Home Assistant App

Runs the full [Claude Code CLI](https://code.claude.com/docs) inside Home Assistant, presented as a web console in the sidebar. Claude has direct access to your HA configuration and APIs: it can create automations, debug integrations, run shell commands, and manage your setup through conversation.

## Installation

1. Go to **Settings → Apps → Install app**, open the **⋮** menu (top right) →
   **Repositories**, paste `https://github.com/LayerTM/ClaudeInHA` and press **Add**.
2. Open **Claude Code** in the App store, then **Install** and **Start**.
3. Click **Open Web UI**. For a **Claude Code** entry in the sidebar, turn on
   **Show in sidebar** on the app's **Info** tab: Home Assistant leaves that
   switch off for every app it installs.

## Authentication (pick one)

| Method | How |
|---|---|
| **Subscription (recommended for interactive console use)** | Leave both fields empty, open the console, run `claude` and follow the login URL. The session survives restarts, but the login can lapse server-side after a period without use (the length is set by the server and not published) — Assist then fails to answer until someone logs in again. For an app left unattended, use the OAuth token below instead. |
| **OAuth token (recommended for Assist/automation)** | On any machine run `claude setup-token`, paste the printed token into **OAuth Token**. No interactive login needed, and it's long-lived. One limit: this token type does not support Remote Control. |
| **API key** | Paste a key from [console.anthropic.com](https://console.anthropic.com) into **API Key**. Pay-per-use. |

## The console

- **Tabs** — ✳ Claude plus any number of shell tabs (+). Exiting Claude shows a restart menu; the session never dies with it.
- **Copy** — hold a modifier and drag to select, and it copies automatically: **Option+drag on macOS**, **Shift+drag on Windows/Linux/ChromeOS** (a real terminal selection). Or press **Cmd+C** / **Ctrl+Shift+C** / **Ctrl+Insert** for the current selection (plain Ctrl+C still interrupts the running program; Ctrl+Insert is the safest on desktop Chrome, where Ctrl+Shift+C also opens DevTools). A wrapped line copies as one line, and it works even over plain HTTP. Without the modifier, a drag goes through tmux and lands in the 📥 tray instead. The ⧉ menu copies the visible screen / recent output / full history without selecting — **this is the copy path on phones**, where text selection isn't available. If the browser blocks clipboard access entirely, copies land in the 📥 tray — tap an entry to copy it. The mouse **wheel scrolls** the history.
- **Paste** — Ctrl+Shift+V / Cmd+V, or the 📋 button. Multi-line text pastes as a single block (bracketed paste), so it lands as one prompt instead of sending line-by-line.
- **Multi-line prompt** — **Shift+Enter** adds a new line without sending (so does **Option/Alt+Enter** and **Ctrl+Enter**); plain **Enter** sends. On phones, the **⇧⏎** key on the key bar inserts a line break. This matches a local terminal set up with `claude`'s `/terminal-setup`.
- **Find** — Cmd+F (macOS) or Ctrl+Shift+F, or the 🔍 button, opens a search bar to find text anywhere in the scrollback; Enter / Shift+Enter step through matches, Esc closes it. On phones, tap 🔍 on the key bar. (Plain Ctrl+F is left for the shell/TUI — it's forward-char in the shell and page-forward in less/vim.)
- **Quick prompts** — the 💡 button drops down a few ready-made prompts (*What changed today?*, *Check my dashboard*, *Check config health*, *Offline / low battery?*, *Recent log errors*). Tapping one inserts the prompt into the console for you to review and send with Enter — nothing runs automatically. Add your own with the `quick_prompts` option — they appear under *Your prompts* in the same menu.
- **Alerts & notifications** — the 🔔 button shows whether proactive alerts are on, any currently-active alerts (leak / low battery / door open at night, with criticals in red), and the messages in your Home Assistant notification bell. Read-only. A badge on the 🔔 shows how many alerts are currently active at a glance (red if any is critical), so you don't have to open the menu to notice.
- **Attach files & images** — drag & drop anywhere, paste an image from the clipboard, or use 📎 (opens camera/gallery on phones). The file is saved under `/data/uploads` and its path is typed into the prompt.
- **Update Claude** — ⬆ button, or `update-claude` in a shell tab (`update-claude 2.1.150` installs a specific version). Only the Claude session restarts; the app keeps running. With **Auto-Update** enabled the CLI also updates at every app start.
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
| `ha-usage [days]` | Summarize Claude token usage (today / N days / all-time, per model) and prompt-API cost. Console usage comes from Claude's session history; chat requests from the prompt API's lines in the audit log. `--json` also says whether the console usage could be read (`available`, and `error` when reading failed). Reading the history gets 20 of the 30 seconds `/api/usage` allows, so a very large history on a slow board can show console usage as unavailable while the prompt API usage is still reported |
| `ha-audit [N]` | Show what Claude has changed: service calls, edits under your config, Core restarts, safety backups, and every change made through a connected tool server (dashboard edits included). Reads are not recorded; a preview is marked `(dry-run)` |
| `yq` | Edit YAML config files |
| `hass-cli` | Entity/service queries (needs **HA Token**) |
| Playwright MCP | Browser automation tools; Chromium is preinstalled |

A **Home Assistant skill pack** is bundled: `/ha-config-edit`, `/ha-automation`,
`/ha-debug`, `/ha-entity`, `/ha-screenshot`, `/ha-backup`, `/ha-addon`,
`/ha-onboard`. General plugins are bundled too (superpowers, frontend-design,
skill-creator, security-guidance, context7, code-review, code-simplifier,
feature-dev, commit-commands, claude-md-management, hookify, document-skills).
All of it lives in `/data/home/.claude` and **persists across app updates**;
provisioning runs once in the background (see `/data/provision.log`).

Add your own with the `plugins`, `marketplaces`, and `skills_git` options —
reconciled on every start. Entries you remove from `plugins` or `marketplaces` are not uninstalled; remove them in the console with `claude plugin uninstall <name>` or `claude plugin marketplace remove <name>`.

## Configuration options

| Option | Purpose |
|---|---|
| `api_key` / `oauth_token` | Authentication (see above). Stored encrypted by the Supervisor. |
| `ha_token` | A Home Assistant Long-Lived Access Token (Profile → Security). Enables dashboard screenshots, `hass-cli`, `hass-mcp` — including its tools for reading **and editing** Lovelace dashboards — and WebSocket/REST access as you. Persists across updates. Optional. |
| `bypass_permissions` | Start Claude with `--dangerously-skip-permissions` (fully autonomous). |
| `protect_secrets` | On by default. Claude can neither read nor change the files where Home Assistant keeps credentials. See [Security and privacy](#security-and-privacy) for the list and its limits. Takes effect at the next app start. |
| `auto_update` | Update the CLI at every app start. Manual `update-claude` always works. |
| `model` | Model override, e.g. `claude-sonnet-4-6`. |
| `custom_instructions` | Text appended to the built-in HA context. Edit your instructions here; they reach the console at the next start. |
| `environment_vars` | Extra env vars, `KEY=VALUE` per entry. |
| `init_commands` | Shell commands run at startup (install tools, MCP servers). |
| `plugins` | Extra plugins to install, `name@marketplace` per entry. |
| `marketplaces` | Extra plugin marketplaces (GitHub `owner/repo`, URL, or path). |
| `skills_git` | Git repo of your own skills, synced into `~/.claude/skills` each start. Each top-level folder must hold a SKILL.md; skills nested deeper (for example in a `skills/` subfolder) are not picked up. |
| `extra_args` | Extra `claude` CLI arguments, one per entry. |
| `launch_command` | Full replacement for the default `claude` invocation. |
| `quick_prompts` | Your own prompts for the 💡 menu — a list of strings. Each becomes a button that *inserts* the text (never auto-runs), shown under *Your prompts*. |
| `upload_retention_days` | Auto-delete attached files after N days (0 = keep). |
| `transcript_retention_days` | Auto-delete conversation transcripts not written to for N days (0 = keep — Claude's own ~10-year cleanup still applies and cannot be turned off outright); their usage stays counted either way. |
| `remote_control` | Adds a tab running `claude remote-control`: drive this session from the Claude mobile app / claude.ai. Requires a full `/login` (subscription); `oauth_token` and API keys are not sufficient. It runs in the same folder as the Claude tab, so accept Claude's trust prompt there once first. |
| `monitoring_interval_hours` | Opt-in proactive monitoring: every N hours Claude reviews the error log and config and notifies you only if it finds something (0 = off). |
| `proactive_alerts` + `alert_*` | Opt-in **deterministic** anomaly alerts (no Claude, no plan usage): notify on a water leak, door/window open at night, low battery, temperature out of band, high CO2, humidity out of band, or a watched device/internet gateway going offline. See *Proactive alerts* below. |
| `prompt_api` | Serve the secure Prompt API for the companion **Claude** (`claude_ha`) integration (on by default). See *The companion integration* below. |
| `api_token` | Optional fixed bearer token for the Prompt API. Leave empty — the app generates one and hands it to the integration via discovery. |
| `prompt_ha_token` | Optional HA token used only by Prompt-API sessions to read state through the MCP Server integration. Best practice: a dedicated non-admin user's token — which works only while the MCP Server's *Require an administrator account* option is off (see *The Home Assistant token for live context* below). Falls back to `ha_token`. |

## Claude in Home Assistant

Claude works in `/homeassistant` (your config) with `/share`, `/media`, `/ssl`, `/backup` mounted. The Supervisor API is available via `$SUPERVISOR_TOKEN`:

```bash
curl -sS -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  http://supervisor/core/api/states | jq '.[].entity_id'
```

The bundled instructions teach Claude the HA API, config patterns, and safety rules (validate config before restart, prefer reloads, and so on). They live in `/data/home/.claude/CLAUDE.md`, which Claude reads in every working directory. At each start the app rewrites its own block of that file (marked by the `BEGIN`/`END` comment lines), so edit `custom_instructions` rather than the block; text you add outside the block, including what Claude saves with `/memory`, is kept. A copy left in `/homeassistant` by an earlier version is renamed to `CLAUDE.md.previous`.

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
- **Offline / network** (`alert_offline`, on) — any entity you list in `alert_offline_entities` that reports `unavailable`/`unknown`, or (for a `device_tracker`) `not_home`. **Critical**: always sent, even during quiet hours. Watches nothing until you list an entity — see below for adding your internet gateway or another critical device.

**Dedupe:** you are notified only when an entity *newly* enters an anomaly. A
still-open door won't re-notify every cycle — the active anomalies are remembered
in `/data/alerts-state.json` and dropped when they clear, so the same entity can
alert again the next time the problem reappears. Turning `proactive_alerts` off clears this
memory when the app next starts, so anything still wrong when you switch alerts
back on is notified again.

**Quiet hours** (`alert_quiet_hours`, e.g. `22:00-07:00`, empty = off): during
this window non-critical alerts (battery, temperature, open-at-night, high CO2)
are held back and stay pending until quiet hours end; critical alerts — water
leak and a watched device going offline — are **always** sent.

All new anomalies from one cycle are batched into a single notification titled
*Claude · Home alert*. As with the monitor and digest, set `HA_NOTIFY_SERVICE`
in Environment Variables to push to your phone; otherwise it lands in the HA
notification bell. Alerts appear only as that notification; the app log shows a line starting with `[cc-alerts]` only for a setup problem, such as an empty offline-entity list.

### Adding, changing, or removing an alert

Every alert is just an option you set in the app's **Configuration** tab — no
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

**Adding a device to the offline watch.** `alert_offline_entities` is empty by
default — the check watches nothing until you list an entity. To be alerted
when a critical device drops off — your internet gateway, a NAS, a camera —
add its `entity_id`:

```yaml
alert_offline_entities:
  - device_tracker.my_gateway
  - sensor.nas_status
  - camera.front_door
```

Any listed entity that reports `unavailable` or `unknown` — or, for a
`device_tracker`, `not_home` — raises a critical *Offline: …* alert. For a
`device_tracker`, watch **always-present infrastructure** (a gateway, NAS, or
camera) — avoid a person's phone tracker, or you'll get an *Offline* alert every
time they leave home. **To remove** a watched device, delete its line, or set
`alert_offline: false` to switch the whole check off. Changes take effect after
you save the options and restart the app — the alerts loop reads its options
when it starts.

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
automations — without opening the console. It talks to this app over a
dedicated, locked-down HTTP endpoint called the **Prompt API**.

The Prompt API is designed for running Claude on **untrusted input** (whatever a
chat message or automation sends) with limited Home Assistant access, so it is
deliberately much more restricted than the interactive console:

- **Separate internal port (8126), never published to the host.** It is reachable
  only from Home Assistant's internal network; requests from anywhere else are
  refused.
- **Bearer token on every request** (constant-time checked). The app generates
  the token and shares it with the integration automatically through Supervisor
  discovery — you configure nothing.
- **Each prompt runs a fresh, stateless, read-only Claude** with deny-by-default
  permissions: shell and file tools are removed entirely (web tools only for an
  opt-in web answer, see below), and the child
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
  secret-redacted; a call is written to the audit log (`ha-audit`) once Home
  Assistant answers it — in this version a write that fails (a full or
  read-only `/data`) goes undetected, so an action can happen with no line —
  and no transcript of a request is kept once it has answered.
- **Its own model — optionally faster for voice.** The companion chat can run a
  different model from the interactive console (`chat_model`) — e.g. a quicker,
  cheaper one for snappy Assist replies — and spoken (voice) turns can use an even
  faster model (`chat_model_voice`), since voice answers are short and lower
  latency matters more there than raw capability. Answering from a camera snapshot
  (`chat_model_camera`) can have its own model too. All of these are optional;
  leave them empty to use the console's model. `chat_model_write` is no longer
  used: a confirmed action runs without a model. Replies are also written in your Home
  Assistant language, and voice replies are kept to one short, spoken-friendly
  sentence.

### The Home Assistant token for live context (`prompt_ha_token`)

Since Home Assistant 2026.10 the Model Context Protocol Server has a
*Require an administrator account* option (Settings → Devices & services →
Model Context Protocol Server → Configure). It is **on** when the integration is
added on 2026.10 or later, and stays **off** for an integration added before.
While it is on, Home Assistant answers `401` to a non-administrator's token, so
Prompt-API sessions get no live context: the app log shows `relay upstream:
Home Assistant refused the add-on's Home Assistant token (401) … for POST
/api/mcp` and the audit log marks each session `mcp=FAILED`. Choose one:

- keep the dedicated non-admin user and turn *Require an administrator account*
  off — then any Home Assistant user's token can use the endpoint; or
- leave the option on and set `prompt_ha_token` to an administrator's token.

### What the app reports about itself (`/api/status`)

Besides readiness and the app's own `version`, `/api/status` names the agent
behind the Prompt API, so the integration can adapt to it:

| field | meaning |
|---|---|
| `engine` | the agent's stable name; `claude` for this app |
| `engine_version` | the agent's version, as `claude --version` reports it; empty until it has been read |
| `claude_version` | the same value, kept for integrations that predate `engine_version` |
| `request_fields` | the request fields `POST /api/prompt` accepts; a field not listed is refused |
| `prompt_max_bytes`, `body_max_bytes` | the largest prompt and request body `POST /api/prompt` accepts |
| `memory_max_bytes` | the largest total size of the remembered facts a request may send in `memory` |
| `auth` | the sign-in's own state — `ok`, `expired` or `unknown` — and since when; kept across restarts and computed without running the agent |

Remembered facts are kept by the integration, not by the app: a request may
send them in `memory`, and they reach the agent as data, never as instructions.
When a message asks to remember or forget something, the answer carries
`memory_change` for the integration to apply after the user confirms it. The
app stores no copy of the facts, and its audit log records only how many
were sent.

A reply the agent itself refuses because the sign-in is no longer accepted ends
with reason `auth-expired` and is never retried.

A read whose Home Assistant token Home Assistant refuses (HTTP 401/403) ends as a
degraded read with reason `ha-token-refused`: the text names the two causes — a
revoked token, or a non-administrator's token while the MCP Server requires an
administrator — and the fix for each.

A confirmed action runs without a model: the app calls the Home Assistant
action for each target itself and answers with `actions`, one entry per target
with `ok` and, when it failed, `error` as Home Assistant reported it. Every
action is attempted; the answer is `200` only when all of them were carried out,
and `502` (`action_failed`) with the same `actions` otherwise.

Every error answer carries a stable `code` next to its message (and `field` or
`limit_bytes` where they apply); the codes are listed in
[ha-agent-core](https://github.com/LayerTM/ha-agent-core#error-answers).

### Web answers (`chat_web`, `chat_web_domains`)

Off by default. With `chat_web` on, the integration can ask for a question to be
answered from the web. A web answer is a separate kind of run:

- **Text only.** It cannot propose or perform an action, and it cannot draft an
  automation.
- **No home.** It sees no entities or states, no remembered facts, no earlier
  conversation and no camera snapshot, and it gets no Home Assistant access at
  all. The answer is not added to the conversation, so later turns never see it.
- **Search is not limited by domain.** Claude's web search can return and
  summarise any public site. `chat_web_domains` lists the sites whose pages the
  answer may additionally *open*; a page on any other site is denied. With the
  list empty there is search only and no page is opened. Entries are public host
  names (`docs.example.com`); names that resolve inside a home or office network
  and bare addresses are refused, and an invalid entry turns the web off with an
  error in the log.
- **Same daily budget.** A web answer counts against `chat_daily_budget_usd`
  like any other chat run.
- **A question leaves your network.** If the prompt contains something from your
  home (a room name, a person, a device), it can reach the search provider as
  part of a search query. Keep that in mind before enabling it.
- **Pages are fetched from your network.** A listed site whose name resolves to a
  home-network address is fetched from inside your network, because the page is
  opened on the app host. List only sites you trust.

### Chat reliability (`chat_health`)

`/api/status` publishes a rolling window over the last 50 companion-chat runs,
which the integration turns into a *chat health* sensor. The window is durable —
it survives an app restart, so an update does not reset it to a flattering
blank — and it is trimmed by **count**, never by age.

That last point is deliberate, and it is why the fields below exist. On an install
where Assist is used a few times a day, "the last 50 runs" spans weeks. So the
app reports **what happened, in what order, and when**, and leaves the question
of *what counts as healthy* to the consumer, which is where the threshold can be
changed without an app release.

| field | meaning |
|---|---|
| `recent` | runs in the window (its full size) |
| `degraded` | how many of them failed |
| `recovered` | how many succeeded only after a retry (a subset of the successes, never of `degraded`) |
| `consecutive_ok` | successes since the last failure — proves a recovery by evidence instead of by a timer |
| `consecutive_failed` | failures since the last success — makes a fresh outage visible before it has diluted the window enough to move the rate |
| `last_reason` | why the most recent failure failed: a short token such as `model-error` or `timeout`, never prompt text or model output |
| `last_failure_ts` | when that same failure happened |
| `window_from_ts` / `window_to_ts` | the span the window actually covers |
| `window_dated` | how many of `recent` those two bounds were measured from |

Every `*_ts` is **epoch milliseconds**, and **`null` means unknown** — never "now"
and never `0`. A window seeded from a file written before app 1.49.0 has no
times at all; those runs still count, they simply cannot say when they happened.
A field that is **absent** rather than null means the app predates it.

**Read the span together with `window_dated`.** It says how many runs the bounds
came from, and it is what makes them readable: `window_dated` equal to `recent`
means the span covers the whole window, a smaller number means it covers only the
part that carries times, and `1` means the two bounds are one sample — a point,
not a span. Undated runs (see above) are the reason the two numbers can differ.

`recent = degraded + successes`, so `recent - degraded` is the number of
successful runs, and a failure rate is `degraded / recent`.

### Account limits (`/api/account_limits`)

`/api/usage` reports what **this app** spent. `/api/account_limits` reports
something different: how much of **your account's** limits you have used — across
every machine and every session, not just the ones that ran here. It is the same
picture the CLI's `/usage` command shows, published so the integration can turn it
into sensors: a percentage per limit (the session window, the week, and the week
for a particular model where your plan has one), with when that limit resets and
how severe the current level is. There are no token counts and no money in it —
a subscription's limits are expressed as percentages, so that is what you get.

If you authenticate with an **API key** rather than a subscription, the endpoint
answers `{"mode": "api_key", "limits": []}`: an API key is billed per request and
has no such limit buckets, so there is nothing to show, and the integration
creates no limit sensors instead of showing empty ones. When the account's
credentials are missing or the upstream service cannot be reached, the endpoint
returns `503` and the sensors go unavailable — it never reports a made-up `0 %`.

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

To use it, install the `claude_ha` integration (it will detect this app
automatically) and, for live HA context, install Home Assistant's *Model Context
Protocol Server* integration and set `prompt_ha_token`. To turn the endpoint off
entirely, set `prompt_api` to false.

## Security and privacy

Claude can read and change your Home Assistant configuration and run shell commands, so know what it
can reach before you give it a task.

### What the app can reach

| Folder | Access |
|---|---|
| `/homeassistant` (your configuration) | read and write, except the protected files below |
| `/config` (this app's own configuration folder) | read and write |
| `/share` | read and write |
| `/media` | read and write |
| `/ssl` | read-only; with `protect_secrets` on, the private keys cannot be read |
| `/backup` | read-only; with `protect_secrets` on, the archives cannot be opened |

Beyond the folders, the app uses the Supervisor API with the `manager` role (it can create backups
and manage other apps) and the Home Assistant API. The Supervisor access does not depend on the
`ha_token` option.

### Protected files

With `protect_secrets` on (the default), Claude cannot read or change:

- `secrets.yaml`, and any `secrets.yaml` below the configuration folder (ESPHome keeps one)
- `.storage/auth` — users' refresh tokens, long-lived access tokens and signing keys
- `.storage/auth_provider.homeassistant` — password hashes
- `.storage/core.config_entries` — every integration's credentials
- `.storage/application_credentials` — OAuth client secrets
- `.cloud/` — the Home Assistant Cloud sign-in
- TLS private keys in `/ssl` (`*.key`, `privkey*.pem`); certificates stay readable
- the archives in `/backup`, which carry a copy of all of the above (backups are still made, listed and
  restored through the Supervisor)

Two things enforce it. The app's AppArmor profile puts the whole console (every tab), the Prompt
API and everything Claude runs into a mode where the kernel refuses these files to any program,
however it opens them. And Claude Code checks each tool call before running it, so a request that
names one of these files is refused with a reason instead of an error. Claude can still use a secret
without seeing it: write `!secret name` in the configuration and add the value to `secrets.yaml`
yourself (see below). The app's log says at start-up which protection is on.

If your configuration folder is a git repository, list the protected files in its `.gitignore`.
Git cannot read them in the protected mode, so `git add -A` stops with "Permission denied" while
any of them is not ignored.

On a host that runs apps without AppArmor (Home Assistant OS always has it), or when the app does not
run under its own AppArmor profile, the kernel half is not available: only Claude Code's check of each
tool call is on, and the start-up log warns about it. If the app runs under its own profile but that
profile lacks the protection (a damaged install), the app does not start while the option is on;
reinstalling it, or turning the option off, starts it again. That check
reads what a call names, so a command that reaches a protected file without naming it (a search
over the whole folder, a script) is not stopped there.

### Working with the protected files

- **Adding a secret.** Claude cannot read or change `secrets.yaml`, so it cannot add a value there
  either. It writes `!secret name` into the configuration and gives you the exact line to add to
  `secrets.yaml` yourself (with the File editor, for example).
- **Searching the configuration.** A search over the whole configuration folder still finds what it
  looks for; the protected files are skipped with a "Permission denied" line for each.
- **Git in the configuration folder.** Keep the protected files out of the repository with
  `.gitignore` (`secrets.yaml`, `.storage/`, `.cloud/`); then `git status`, `git add -A` and commits
  work as before. If a protected file is already tracked, git keeps working until that file changes;
  once it has changed (or when it is forced in with `git add -f`), `git add` and `git commit` stop with
  "Permission denied" and nothing is staged or committed. Remove it from the repository
  (`git rm --cached secrets.yaml`) and ignore it.

### What the protection does not cover

It keeps the files away from Claude. It does not make Claude unable to reach a credential in every
possible way:

- **Backups through the Supervisor.** The app may create backups, and the Supervisor API would hand one
  out for download; a backup contains these files.
- **The next start.** Claude can change the app's options through the Supervisor, including turning
  `protect_secrets` off, and the change applies when the app restarts. That cannot be prevented
  without taking the Supervisor away from it, so it is made visible: whenever the app starts with
  less protection than at its previous start — the option turned off, or the kernel half lost —
  Home Assistant shows a notification ("Secrets protection was turned off" or "… was weakened",
  with the reason) and the app's log says so. What decides the protection at start-up (the app's
  options file, its start scripts and the static shell that runs them) is out of Claude's reach.
  The everyday programs the notification uses are not, but every restart recreates the app's
  container, so a program Claude changed is gone by the time that start runs; what Claude keeps across
  restarts (an `init_commands` entry, a program it installs in `/data`) runs at the next start
  like everything else, with the protection applied as the options say.
- **Other apps' options.** The app manages Home Assistant through the Supervisor, and the Supervisor
  API hands it the options of other apps, which can hold their passwords and tokens.
- **Home Assistant itself.** Claude writes your configuration and automations; one written to expose a
  value would make Home Assistant reveal it.
- **The app's own credentials.** The Supervisor token, `ha_token` and the Claude sign-in are what the
  app works with, so they are in its environment and its own files, not behind the protection.
- **Moved folders.** The protected paths are names. The folders that hold them (the configuration
  folder, its `.storage` and `.cloud`, `/ssl`, `/backup`) cannot be renamed, but another folder that
  holds a `secrets.yaml` (ESPHome's) could be renamed on purpose to reach the file under a new name.
- **Other places.** A credential copied into another file (a script, an automation, a note) is not
  protected, and neither is an older copy kept in history — a git repository in the configuration
  folder that once committed `secrets.yaml` still holds it.

Treat it as protection against Claude opening your credentials by accident or because a task led it
there — not as a wall against an agent set on getting them.

### What leaves your home

Whatever Claude reads or runs in a session — a file, a command's output, an entity state — becomes
part of the conversation and is sent to Anthropic, to answer you. Nothing is sent through any other
server.

### Permission prompts

With `bypass_permissions` off (the default) Claude asks before it runs a shell command (apart from a
built-in set of read-only ones) and before it edits or writes a file; reading files in the folder it
starts in, `/homeassistant`, is not prompted for. With `bypass_permissions` on it asks about nothing.
`protect_secrets` holds in both. Chats from Assist or automations through the companion integration
never prompt: they run with a narrow, fixed set of allowed tools and everything else is refused.

### The Home Assistant token

`ha_token` is optional. When set, Claude calls the Home Assistant API with that user's rights, so it
can do whatever that user can. Reading and editing dashboards through `hass-mcp` needs an
administrator: Home Assistant refuses to save or delete a dashboard configuration for any other
user. If you do not need that, use the token of a dedicated non-administrator user, or leave it empty.

## Persistence

Everything that matters lives in `/data` and survives restarts and updates: login and sessions (`/data/home/.claude`), the CLI binary (`/data/home/.local`), uploads (`/data/uploads`). Resume the last conversation with `claude --resume` or the `c` option in the exit menu.

## Troubleshooting

- **Blank screen** — check the app log; restart the app.
- **401 / frozen after long idle** — the ingress session expires after 15 minutes without traffic; the console reloads automatically, or refresh the page.
- **Copy does not reach the clipboard** — rare now (selecting text copies in the pointer gesture, which works over plain HTTP too). If a browser blocks the clipboard even inside a gesture, the text is still saved to the 📥 tray — one tap to copy — and serving HA over HTTPS avoids it entirely.
- **TLS on Home Assistant itself** — if you set `ssl_certificate` in the `http:` integration, or moved
  Core off port 8123, the app follows automatically: it asks the Supervisor where Core listens
  instead of assuming `http://homeassistant:8123`. Nothing to configure. Inside the app,
  `$HA_URL` always holds the right address — prefer it over a hardcoded one in scripts.
- **`bypass_permissions` refuses to start** — the app sets `IS_SANDBOX=1` automatically; if a CLI update ever breaks this, run `claude install <previous-version> --force` in a shell tab and report an issue.

## Works with

- [**claude-ha**](https://github.com/LayerTM/claude-ha) — the companion integration: chat with Claude from Assist and automations through this app (HACS default repository).
- [**CodexInHA**](https://github.com/LayerTM/CodexInHA) — the same console and Assist chat for OpenAI's coding agent.

## Support

Issues: [github.com/LayerTM/ClaudeInHA](https://github.com/LayerTM/ClaudeInHA/issues)
