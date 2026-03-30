# Claude Code — Home Assistant Add-on

[![Add Repository to HA](https://my.home-assistant.io/badges/supervisor_store.svg)](https://my.home-assistant.io/redirect/supervisor_store/?repository_url=https%3A%2F%2Fgithub.com%2FLayerTM%2FClaudeInHA)

This repository provides a [Home Assistant](https://www.home-assistant.io/) add-on that embeds the full [Claude Code CLI](https://docs.anthropic.com/claude-code) into Home Assistant as a web terminal accessible directly from the sidebar.

## What it does

- Runs Claude Code CLI in a web terminal inside Home Assistant
- Claude has direct access to your HA config files, REST API, and Supervisor API
- Auto-updates Claude Code independently of the add-on (no new add-on release needed)
- Supports full Claude Code functionality: skills, plugins, MCP servers, internet access
- Supports `bypassPermissions` mode for fully autonomous operation
- Session persists via tmux — closing the browser does not kill the session

## Installation

1. Click the badge above, or go to **Settings → Add-ons → Add-on Store → Repositories** and add:
   ```
   https://github.com/LayerTM/ClaudeInHA
   ```
2. Install **Claude Code** from the store
3. Set your Anthropic API key in the **Configuration** tab
4. Start the add-on and open the **Claude Code** sidebar panel

## Requirements

- Home Assistant OS or Supervised
- Anthropic API key ([console.anthropic.com](https://console.anthropic.com)) — or Claude.ai subscription

## Documentation

Full documentation is available in the add-on's **Documentation** tab inside Home Assistant, or in [DOCS.md](claude-code/DOCS.md).

## Supported Architectures

- `amd64` (x86-64)
- `aarch64` (ARM64, Raspberry Pi 4/5)

## License

MIT
