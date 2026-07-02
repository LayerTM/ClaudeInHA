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

## Configuration options

| Option | Purpose |
|---|---|
| `api_key` / `oauth_token` | Authentication (see above). Stored encrypted by the Supervisor. |
| `bypass_permissions` | Start Claude with `--dangerously-skip-permissions` (fully autonomous). |
| `auto_update` | Update the CLI at every add-on start. Manual `update-claude` always works. |
| `model` | Model override, e.g. `claude-sonnet-4-6`. |
| `custom_instructions` | Text appended to the built-in HA context (CLAUDE.md). |
| `environment_vars` | Extra env vars, `KEY=VALUE` per entry. |
| `init_commands` | Shell commands run at startup (install tools, MCP servers). |
| `extra_args` | Extra `claude` CLI arguments, one per entry. |
| `launch_command` | Full replacement for the default `claude` invocation. |
| `upload_retention_days` | Auto-delete attached files after N days (0 = keep). |
| `remote_control` | Adds a tab running `claude remote-control`: drive this session from the Claude mobile app / claude.ai. Requires a full `/login` (subscription); `oauth_token` and API keys are not sufficient. |

## Claude in Home Assistant

Claude works in `/homeassistant` (your config) with `/share`, `/media`, `/ssl`, `/backup` mounted. The Supervisor API is available via `$SUPERVISOR_TOKEN`:

```bash
curl -sS -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  http://supervisor/core/api/states | jq '.[].entity_id'
```

The bundled `CLAUDE.md` teaches Claude the HA API, config patterns, and safety rules (validate config before restart, prefer reloads, and so on).

MCP servers, skills, and plugins work exactly as in the desktop CLI: `.mcp.json` in `/homeassistant`, skills under `/data/home/.claude/skills/`, `claude plugin install <name>`.

## Persistence

Everything that matters lives in `/data` and survives restarts and updates: login and sessions (`/data/home/.claude`), the CLI binary (`/data/home/.local`), uploads (`/data/uploads`). Resume the last conversation with `claude --resume` or the `c` option in the exit menu.

## Troubleshooting

- **Blank screen** — check the add-on log; restart the add-on.
- **401 / frozen after long idle** — the ingress session expires after 15 minutes without traffic; the console reloads automatically, or refresh the page.
- **Copy does not reach the clipboard** — expected on plain-HTTP setups and in the Android app: use the 📥 tray (one tap) or serve HA over HTTPS.
- **`bypass_permissions` refuses to start** — the add-on sets `IS_SANDBOX=1` automatically; if a CLI update ever breaks this, run `claude install <previous-version> --force` in a shell tab and report an issue.

## Support

Issues: [github.com/LayerTM/ClaudeInHA](https://github.com/LayerTM/ClaudeInHA/issues)
