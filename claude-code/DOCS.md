# Claude Code — Home Assistant Add-on

Claude Code is Anthropic's official AI coding assistant. This add-on embeds the full Claude Code CLI into Home Assistant as a web terminal accessible from the sidebar. Claude has direct access to your HA configuration files and APIs, enabling it to create automations, debug integrations, write scripts, and manage your entire HA setup through conversation.

---

## What Claude Code Can Do

- Read and edit any file in `/homeassistant` (your HA config)
- Create and modify automations, scripts, scenes, and templates
- Query the Home Assistant REST API (entity states, services, logs)
- Restart HA, reload automations, call any service
- Install tools (npm packages, Python packages, Alpine packages)
- Run shell commands, search files, use git
- Connect to external MCP servers (GitHub, databases, APIs, etc.)
- Use custom skills (slash commands) and plugins
- Access the internet for documentation, APIs, and packages

---

## Prerequisites

- A Home Assistant OS or Supervised installation
- An **Anthropic API key** from [console.anthropic.com](https://console.anthropic.com)
  *(Free tier available; alternatively use Claude.ai subscription via `claude auth login`)*

---

## Installation

### 1. Add this repository to Home Assistant

Go to **Settings → Add-ons → Add-on Store** → three-dot menu (⋮) → **Repositories**

Paste:
```
https://github.com/LayerTM/ClaudeInHA
```

### 2. Install the add-on

Find **Claude Code** in the store and click **Install**.
The first install downloads the Claude Code binary (~100 MB) and may take a few minutes.

### 3. Configure

Go to the **Configuration** tab and set:

| Option | Value |
|--------|-------|
| **API Key** | Your Anthropic API key (`sk-ant-...`) |
| **Skip Permission Prompts** | `false` (recommended initially) |
| **Auto-Update** | `true` (recommended) |

### 4. Start

Click **Start** on the **Info** tab.

### 5. Open the terminal

Click **Claude Code** in the left sidebar, or toggle **Show in sidebar** on the Info tab first.

---

## Configuration Options

### API Key
Your Anthropic API key (`sk-ant-...`). Get one at [console.anthropic.com](https://console.anthropic.com).

Leave empty if you prefer to log in via subscription (see [Authentication without API Key](#authentication-without-api-key)).

**Security**: The key is stored encrypted by the HA Supervisor and is never visible in logs or committed to version control.

### Skip Permission Prompts
When **enabled**, Claude Code will not ask for confirmation before:
- Running shell commands
- Editing or creating files
- Calling any tool

This corresponds to the `--dangerously-skip-permissions` flag. Enable it when you want fully autonomous operation. **Use with caution** — Claude will execute actions without confirmation.

### Auto-Update Claude Code
When **enabled** (default), Claude Code checks for and installs updates each time the add-on starts. This allows Claude Code to update independently of new add-on releases.

When **disabled**, set `DISABLE_AUTOUPDATER=1` and no automatic updates occur. You can still update manually:
```bash
claude update
```

### Model Override
Specify a model to use instead of Claude Code's default. Examples:
- `claude-opus-4-6` — most capable
- `claude-sonnet-4-6` — fast and capable
- `claude-haiku-4-5-20251001` — fastest

Leave empty for the default model.

### Custom Instructions
Text appended to the built-in Home Assistant context file (`CLAUDE.md`). Use this to add:
- Your preferences ("always use descriptive entity names")
- Project context ("this house has Philips Hue lights and a Sonos system")
- Coding standards

### Extra Environment Variables
Additional environment variables. Format: `KEY=VALUE` — one per entry.

Example uses:
- `GITHUB_TOKEN=ghp_...` (for GitHub MCP server)
- `NODE_OPTIONS=--max-old-space-size=4096` (increase Node.js memory)

### Initialization Commands
Shell commands run at add-on startup before Claude Code launches. Use this to install additional tools or MCP servers that should be available every time. Examples:
- `npm install -g @modelcontextprotocol/server-github`
- `apk add --no-cache ffmpeg`
- `pip install homeassistant-api`

---

## Using Claude Code with Home Assistant

Open the sidebar panel and start describing what you want. Claude Code has full access to your HA config and can take direct action.

### Example prompts

**Automations:**
```
Create an automation that turns on the living room lights at sunset
and turns them off at 11pm
```

```
Add a trigger to my "Morning routine" automation that also fires
when I arrive home
```

**Debugging:**
```
Check my configuration.yaml for any errors and show me what's wrong
```

```
I'm getting errors in the HA log about my MQTT integration.
Show me the last 50 error lines and help me fix them
```

**Scripts:**
```
Create a script that gradually dims all lights over 30 minutes
and plays a goodnight announcement
```

**System:**
```
List all my entities and show me which ones haven't reported
a state change in the last 24 hours
```

```
Restart Home Assistant after validating the configuration
```

### Accessing the HA API directly

Claude Code has `$SUPERVISOR_TOKEN` available for direct API calls:

```bash
# Inside the terminal, query any HA API endpoint
curl -sS -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  http://supervisor/core/api/states | jq '.[].entity_id'
```

---

## Session Persistence

Claude Code runs inside a **tmux session**. This means:

- Closing the browser tab does **not** end the Claude session
- Reopen the sidebar panel to reconnect to your existing session
- The session continues running even if you navigate away from HA
- On add-on **restart**, a new tmux session is created (the previous session ends)

Session history is preserved in `~/.claude/sessions/` and can be resumed:
```bash
claude --resume    # Resume last session
claude -c          # Continue most recent conversation
```

---

## Advanced: MCP Servers

MCP (Model Context Protocol) servers extend Claude Code with additional tools and data sources.

### Configure via file

Create or edit `/homeassistant/.mcp.json`:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_your_token"
      }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/homeassistant"]
    }
  }
}
```

> **Security**: Do not put real API tokens in files committed to version control.
> Use the **Extra Environment Variables** add-on option and reference them via `${VAR_NAME}`.

### Configure via CLI (current session)

```bash
claude mcp add github -- npx -y @modelcontextprotocol/server-github
claude mcp list
claude mcp remove github
```

### Install MCP servers permanently

Add to **Initialization Commands** in add-on config:
```
npm install -g @modelcontextprotocol/server-github
```

Then reference with `command: "mcp-server-github"` (no `npx -y` needed).

---

## Advanced: Skills and Plugins

### Skills (Slash Commands)

Skills are custom slash commands defined in Markdown files.

Place skill files in `/data/home/.claude/skills/<skill-name>/SKILL.md`.

Example — create a HA-specific commit skill:
```bash
mkdir -p /data/home/.claude/skills/ha-backup
cat > /data/home/.claude/skills/ha-backup/SKILL.md << 'EOF'
---
name: ha-backup
description: Create a backup of the HA configuration
---

Create a timestamped backup of /homeassistant to /share/backups/
using tar. Name it ha-config-YYYY-MM-DD.tar.gz
EOF
```

Use it with `/ha-backup` in Claude Code.

### Plugins

Install plugins from the Claude Code marketplace or local path:

```bash
claude plugin install <name>
claude plugin list
claude plugin update <name>
```

---

## Updating Claude Code

Claude Code updates are **independent** of add-on version updates.

| Method | When it runs |
|--------|-------------|
| Auto-update on startup | Every add-on start (if Auto-Update is enabled) |
| Manual: `claude update` | On demand from the terminal |
| Add-on update | Rebuilds container with latest binary (also pulls updates) |

The Claude Code binary is stored in persistent storage (`/data/home/.local/`) so updates survive add-on restarts without re-downloading from scratch.

---

## File Locations

| Purpose | Path |
|---------|------|
| HA configuration | `/homeassistant/` |
| Claude Code binary | `/data/home/.local/bin/claude` |
| Claude Code config | `/data/home/.claude/` |
| Skills | `/data/home/.claude/skills/` |
| HA context (CLAUDE.md) | `/homeassistant/CLAUDE.md` and `/data/workdir/CLAUDE.md` |
| MCP config | `/homeassistant/.mcp.json` |
| Shared storage | `/share/` |
| Media | `/media/` |

---

## Authentication Without API Key

If you have a Claude.ai **Pro/Max/Teams** subscription, you can use it instead of an API key:

1. Leave the **API Key** field empty
2. Start the add-on
3. Open the sidebar terminal
4. Run: `claude auth login`
5. Claude will display a URL — open it in your browser
6. Complete authentication
7. Your session will be saved to `/data/home/.claude/` and persist across restarts

---

## Troubleshooting

### Blank screen / terminal not loading
- Check add-on logs (**Info** tab → **Log**)
- Try restarting the add-on
- Check that the add-on is fully started (green indicator)

### "No API key set" warning in logs
Normal if using OAuth login. Run `claude auth login` in the terminal.

### Slow first startup
Normal — the first start copies the Claude Code binary to persistent storage and may check for updates. Subsequent starts are fast.

### Session lost after add-on restart
Expected behavior — add-on restart creates a new container and new tmux session. Use `claude --resume` to continue from the last conversation.

### Claude Code update fails
Non-critical — logged as a warning. Check your internet connection. Try `claude update` manually in the terminal.

### Permission denied errors
If Claude is blocked from editing files, check that `homeassistant_config` is mapped with `read_only: false` in the add-on config. This is the default — if you modified it, restore it.

### MCP server not found
Run the install command manually in the terminal first to check for errors:
```bash
npx -y @modelcontextprotocol/server-github
```

---

## Security

- **API key**: Stored encrypted by HA Supervisor. Never visible in logs or git.
- **SUPERVISOR_TOKEN**: Injected automatically at runtime by HA. Not stored anywhere.
- **Network**: ttyd web terminal binds to the internal HA network only — not exposed externally. Access is gated by HA authentication.
- **bypass_permissions**: Grants Claude Code unrestricted action. Only enable if you understand the implications and trust the AI's judgment.
- **Container isolation**: This add-on runs in an isolated Docker container with no special Linux capabilities beyond what's needed.

---

## Support

- GitHub Issues: [github.com/LayerTM/ClaudeInHA](https://github.com/LayerTM/ClaudeInHA/issues)
- Claude Code documentation: [docs.anthropic.com/claude-code](https://docs.anthropic.com/claude-code)
