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
- **Copy** — select with Shift+drag (copies automatically), or use the ⧉ menu to copy the visible screen / recent output / full history without selecting anything. When the browser blocks clipboard access (plain HTTP, Android app), copies land in the 📥 tray — tap an entry to copy it.
- **Paste** — Ctrl+Shift+V / Cmd+V, or the 📋 button.
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

To use it, install the `claude_ha` integration (it will detect this add-on
automatically) and, for live HA context, install Home Assistant's *Model Context
Protocol Server* integration and set `prompt_ha_token`. To turn the endpoint off
entirely, set `prompt_api` to false.

## Persistence

Everything that matters lives in `/data` and survives restarts and updates: login and sessions (`/data/home/.claude`), the CLI binary (`/data/home/.local`), uploads (`/data/uploads`). Resume the last conversation with `claude --resume` or the `c` option in the exit menu.

## Troubleshooting

- **Blank screen** — check the add-on log; restart the add-on.
- **401 / frozen after long idle** — the ingress session expires after 15 minutes without traffic; the console reloads automatically, or refresh the page.
- **Copy does not reach the clipboard** — expected on plain-HTTP setups and in the Android app: use the 📥 tray (one tap) or serve HA over HTTPS.
- **`bypass_permissions` refuses to start** — the add-on sets `IS_SANDBOX=1` automatically; if a CLI update ever breaks this, run `claude install <previous-version> --force` in a shell tab and report an issue.

## Support

Issues: [github.com/LayerTM/ClaudeInHA](https://github.com/LayerTM/ClaudeInHA/issues)
