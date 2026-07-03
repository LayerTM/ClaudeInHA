<div align="center">

<img src="images/logo.png" alt="Claude Code for Home Assistant" width="440">

# Claude Code — Home Assistant Add-on

Anthropic's [Claude Code](https://code.claude.com/docs) CLI, embedded in Home Assistant as a polished web console — right in the sidebar.

[![Open your Home Assistant instance and show the add-on repository dialog.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FLayerTM%2FClaudeInHA)

[![Version](https://img.shields.io/badge/dynamic/yaml?url=https%3A%2F%2Fraw.githubusercontent.com%2FLayerTM%2FClaudeInHA%2Fmain%2Fclaude-code%2Fconfig.yaml&query=%24.version&prefix=v&label=version&color=D97757)](claude-code/CHANGELOG.md)
[![Project Stage](https://img.shields.io/badge/stage-experimental-E5A00D)](https://developers.home-assistant.io/docs/add-ons/configuration#add-on-config)
[![License](https://img.shields.io/github/license/LayerTM/ClaudeInHA?color=blue)](LICENSE)
[![Home Assistant Add-on](https://img.shields.io/badge/Home%20Assistant-Add--on-18BCF2?logo=home-assistant&logoColor=white)](https://www.home-assistant.io/)

[![amd64](https://img.shields.io/badge/amd64-supported-2ea043)](claude-code/config.yaml)
[![aarch64](https://img.shields.io/badge/aarch64-supported-2ea043)](claude-code/config.yaml)
&nbsp;
[![tests](https://github.com/LayerTM/ClaudeInHA/actions/workflows/tests.yml/badge.svg)](https://github.com/LayerTM/ClaudeInHA/actions/workflows/tests.yml)
[![lint](https://github.com/LayerTM/ClaudeInHA/actions/workflows/lint.yml/badge.svg)](https://github.com/LayerTM/ClaudeInHA/actions/workflows/lint.yml)
[![secret-scan](https://github.com/LayerTM/ClaudeInHA/actions/workflows/secret-scan.yml/badge.svg)](https://github.com/LayerTM/ClaudeInHA/actions/workflows/secret-scan.yml)
[![pre-commit](https://img.shields.io/badge/pre--commit-enabled-brightgreen?logo=pre-commit&logoColor=white)](.pre-commit-config.yaml)
[![Last commit](https://img.shields.io/github/last-commit/LayerTM/ClaudeInHA?color=41BDF5)](https://github.com/LayerTM/ClaudeInHA/commits/main)
[![Stars](https://img.shields.io/github/stars/LayerTM/ClaudeInHA?color=41BDF5&logo=github&logoColor=white)](https://github.com/LayerTM/ClaudeInHA/stargazers)

<img src="images/screenshot.png" alt="Claude Code console in the Home Assistant sidebar" width="820">

</div>

## Features

- **Real Claude Code CLI** — skills, plugins, MCP servers, and slash commands all work
- **Zero-prep HA toolkit** — a bundled Home Assistant skill pack (`/ha-automation`, `/ha-debug`, `/ha-screenshot`, …), general plugins (superpowers, frontend-design, …), and the `ha`/`yq`/`hass-cli` tools, all preinstalled and persisted across updates
- **Browser testing built in** — Chromium is preinstalled; screenshot any dashboard with `ha-shot`, or use the Playwright MCP for interactive checks
- **Tabs** — the Claude session alongside any number of shell tabs
- **Clipboard that works everywhere**, including plain-HTTP setups and the mobile companion app
- **Attachments** — drag & drop files, paste images, or pick from your camera/gallery
- **One-click CLI updates** without restarting the add-on (auto-update on start included)
- **Full Home Assistant access** — config files, REST API, Supervisor API, and (with an HA token) WebSocket
- **Session persistence** via tmux — closing the browser never kills Claude
- **Mobile-friendly** — touch key bar, full-screen kiosk mode, installable as a PWA
- **Remote Control** (optional) — drive the session from the official Claude mobile app

## Installation

1. Click the badge above, or add this repository under
   **Settings → Add-ons → Add-on Store → ⋮ → Repositories**:
   ```
   https://github.com/LayerTM/ClaudeInHA
   ```
2. Install **Claude Code** from the store and start it.
3. Open the **Claude Code** panel in the sidebar.

Authenticate by running `claude` in the console and following the login URL
(subscription), or set an API key / OAuth token in the configuration. See the
[documentation](claude-code/DOCS.md) for details.

## Requirements

- Home Assistant OS or Supervised (`amd64` or `aarch64`)
- A Claude subscription (Pro/Max/Team) or an Anthropic API key

## Documentation

Full documentation lives in the add-on's **Documentation** tab, or in
[`claude-code/DOCS.md`](claude-code/DOCS.md).

## License

[MIT](LICENSE) © 2026 LayerTM

Claude and Claude Code are products of Anthropic. This is an independent,
community-maintained add-on and is not affiliated with or endorsed by
Anthropic or the Home Assistant project.
