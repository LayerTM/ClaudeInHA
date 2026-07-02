# Claude Code — Home Assistant Add-on

[![Add Repository to HA](https://my.home-assistant.io/badges/supervisor_store.svg)](https://my.home-assistant.io/redirect/supervisor_store/?repository_url=https%3A%2F%2Fgithub.com%2FLayerTM%2FClaudeInHA)

A [Home Assistant](https://www.home-assistant.io/) add-on that embeds the full [Claude Code CLI](https://code.claude.com/docs) as a web console in the HA sidebar.

## Features

- Real Claude Code CLI — skills, plugins, MCP servers, slash commands all work
- Tabs: Claude session plus any number of shell tabs
- Clipboard that works everywhere, including plain-HTTP setups and the mobile companion app
- Attach files and images: drag & drop, clipboard paste, camera/gallery picker
- One-click Claude CLI update without restarting the add-on (auto-update on start included)
- Direct access to HA config files, REST API, and Supervisor API
- Session persists in tmux — closing the browser never kills Claude
- Optional Remote Control: drive the session from the official Claude mobile app
- `bypassPermissions` mode for fully autonomous operation

## Installation

1. Click the badge above, or add this repository under **Settings → Add-ons → Add-on Store → Repositories**:
   ```
   https://github.com/LayerTM/ClaudeInHA
   ```
2. Install **Claude Code** from the store and start it
3. Authenticate: run `claude` in the console and follow the login URL (subscription), or set an API key / OAuth token in the configuration — details in the add-on documentation

## Requirements

- Home Assistant OS or Supervised, `amd64` or `aarch64`
- Claude subscription (Pro/Max/Team) or an Anthropic API key

## Documentation

Full documentation is in the add-on's **Documentation** tab inside Home Assistant, or in [DOCS.md](claude-code/DOCS.md).

## License

MIT
