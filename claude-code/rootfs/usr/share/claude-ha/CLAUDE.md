# Home Assistant Environment

You are running inside a **Home Assistant OS add-on** container. Your purpose is to help the user manage, configure, automate, and debug their Home Assistant instance.

## Available Filesystems

| Mount Path | Contents | Writable |
|---|---|---|
| `/homeassistant` | HA configuration directory (`configuration.yaml`, automations, scripts, etc.) | Yes |
| `/share` | Shared storage between all add-ons | Yes |
| `/media` | Media files | Yes |
| `/ssl` | TLS certificates | **No** |
| `/backup` | Backup archives | No |
| `/config` | This add-on's persistent config | Yes |

> `/homeassistant/configuration.yaml` is the main HA config file. Many sub-sections use `!include` to reference separate YAML files in the same directory.

---

## Home Assistant Supervisor API

Base URL: `http://supervisor`
Authentication: `Authorization: Bearer $SUPERVISOR_TOKEN`

The `$SUPERVISOR_TOKEN` environment variable is automatically available in this container.

### Entity States

```bash
# List ALL states
curl -sS -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  http://supervisor/core/api/states | jq .

# Get a specific entity
curl -sS -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  http://supervisor/core/api/states/light.living_room | jq .

# Get all entities of a domain
curl -sS -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  http://supervisor/core/api/states | jq '[.[] | select(.entity_id | startswith("sensor."))]'
```

### Services

```bash
# List all services
curl -sS -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  http://supervisor/core/api/services | jq .

# Call a service
curl -sS -X POST \
  -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "light.living_room"}' \
  http://supervisor/core/api/services/light/turn_on

# Turn off a light
curl -sS -X POST \
  -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "light.living_room"}' \
  http://supervisor/core/api/services/light/turn_off

# Trigger an automation
curl -sS -X POST \
  -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "automation.my_automation"}' \
  http://supervisor/core/api/services/automation/trigger
```

### Configuration Management

```bash
# Check configuration validity BEFORE restarting
curl -sS -X POST \
  -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  http://supervisor/core/api/config/core/check

# Reload specific components (no full restart needed)
curl -sS -X POST \
  -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  http://supervisor/core/api/services/homeassistant/reload_config_entry

# Reload automations
curl -sS -X POST \
  -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  http://supervisor/core/api/services/automation/reload

# Reload scripts
curl -sS -X POST \
  -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  http://supervisor/core/api/services/script/reload

# Restart Home Assistant Core (use sparingly — triggers full restart)
curl -sS -X POST \
  -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  http://supervisor/core/api/services/homeassistant/restart
```

### Logs & Diagnostics

```bash
# Get HA error log
curl -sS -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  http://supervisor/core/api/error_log

# Get HA core info
curl -sS -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  http://supervisor/core/api/config | jq .

# Get Supervisor info
curl -sS -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  http://supervisor/info | jq .

# List installed add-ons
curl -sS -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  http://supervisor/addons | jq '.data.addons[] | {slug, name, state}'
```

---

## Important Rules

1. **Validate before restart**: Always run the config check before calling restart
2. **YAML indentation**: HA uses strict YAML — always 2-space indentation, no tabs
3. **Do NOT write to `/ssl`**: Certificates directory is read-only
4. **Backup before destructive changes**: Copy important files before modifying
5. **Prefer reloads over restarts**: Use `automation/reload`, `script/reload` etc. when possible
6. **`!include` files**: When `configuration.yaml` uses `!include automations.yaml`, edit the included file, not the main file

---

## Common HA Configuration Patterns

### Adding an automation (automations.yaml)

```yaml
- id: "unique_id_here"
  alias: "My Automation"
  description: "What this automation does"
  trigger:
    - platform: state
      entity_id: binary_sensor.front_door
      to: "on"
  condition: []
  action:
    - service: notify.mobile_app
      data:
        message: "Front door opened!"
  mode: single
```

### Adding a script (scripts.yaml)

```yaml
my_script:
  alias: "My Script"
  sequence:
    - service: light.turn_on
      target:
        entity_id: light.living_room
      data:
        brightness: 255
```

### Adding a template sensor (configuration.yaml)

```yaml
template:
  - sensor:
      - name: "My Template Sensor"
        state: "{{ states('sensor.temperature') | float + 2 }}"
        unit_of_measurement: "°C"
```

---

## Installing Additional Tools

```bash
# Alpine packages (available immediately)
apk add --no-cache <package-name>

# Node.js packages (for MCP servers, scripts)
npm install -g <package-name>

# Python packages (for MCP servers, scripts)
pip install --break-system-packages <package-name>
```

---

## MCP Server Configuration

To add MCP servers permanently, create or edit `/homeassistant/.mcp.json`:

```json
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "@scope/mcp-server-package"],
      "env": {
        "API_KEY": "your-api-key"
      }
    }
  }
}
```

Or add via CLI (session scope):
```bash
claude mcp add my-server -- npx -y @scope/mcp-server
```

---

## Skills and Plugins

- **Skills** (slash commands): place in `/data/home/.claude/skills/<skill-name>/SKILL.md`
- **Plugins**: `claude plugin install <name>`
- **List current skills**: available as `/skill-name` in Claude Code

---

## Notes

- This container runs Alpine Linux
- Internet access is available (needed for Claude API, MCP servers, npm packages)
- Session persists in tmux — closing the browser tab does not end the session
- On add-on restart, start a new session (history is preserved in `~/.claude/sessions/`)
