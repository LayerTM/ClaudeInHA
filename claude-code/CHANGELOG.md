# Changelog

## [0.1.0] — 2026-03-30

### Added
- Initial release of Claude Code add-on for Home Assistant
- Web terminal via ttyd with xterm.js/WebGL renderer, accessible from HA sidebar
- tmux session persistence — browser disconnect does not kill the Claude session
- Claude Code native binary (supports amd64 and aarch64)
- Auto-update: Claude Code updates independently of the add-on version
- Full Home Assistant integration:
  - Mounts `/homeassistant`, `/share`, `/media`, `/ssl`, `/backup`
  - Supervisor API and HA Core API access via `$SUPERVISOR_TOKEN`
  - Default `CLAUDE.md` with HA-specific context, API examples, and config patterns
- `bypass_permissions` option: `--dangerously-skip-permissions` mode
- `model` option: override Claude model
- `custom_instructions` option: append custom text to CLAUDE.md
- `environment_vars` option: inject additional environment variables
- `init_commands` option: run shell commands at startup
- Full MCP server support (configure via `.mcp.json` or `claude mcp add`)
- Full skills and plugin support
- Binary and config persist in `/data/home/` across add-on restarts
