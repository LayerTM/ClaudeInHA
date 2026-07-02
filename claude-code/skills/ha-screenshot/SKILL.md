---
name: ha-screenshot
description: Capture and visually verify how a Home Assistant dashboard, view, or Lovelace card looks. Use when the user wants to see/check a dashboard's appearance, or after editing Lovelace to confirm the change rendered correctly.
---

Visually verify Home Assistant UI by capturing a screenshot, then **reading the PNG** to evaluate. Never claim a dashboard "looks right" without looking at a fresh screenshot.

## Primary: `ha-shot`

Screenshots an authenticated Lovelace dashboard to PNG. Requires the add-on's **HA Token** (Long-Lived Access Token) option to be set — if unset, `ha-shot` prints a hint; tell the user to set it in the add-on config.

```bash
ha-shot <dashboard-path> [output.png] [WIDTHxHEIGHT]
```

```bash
# Default dashboard, first view
ha-shot /lovelace/0 /tmp/dash.png 1280x800

# A named view within the default dashboard
ha-shot /lovelace/lights /tmp/lights.png 1280x800

# A specific dashboard by its url_path
ha-shot /lovelace-energy/0 /tmp/energy.png 1280x800

# Mobile-width check
ha-shot /lovelace/0 /tmp/mobile.png 414x896
```

Then evaluate it — **Read the PNG** (`/tmp/dash.png`) so you actually see the result. Judge layout, card contents, empty/error states, and whether the edit took effect.

### Path reference
- `/lovelace/0` — default dashboard, view index `0` (also `/1`, `/2`, …).
- `/lovelace/<view-path>` — a view by its `path:` slug.
- `/<dashboard-url_path>/<view>` — a non-default dashboard (its `url_path` from config).

### Sizing
- Desktop: `1280x800` (default-ish). Wide dashboards: `1920x1080`.
- Mobile: `414x896`. Use it to catch responsive/column breakage.

## Iterating on a card
After changing a card in the Lovelace config (edit the `!include`d dashboard file, 2-space YAML, never tabs):

1. If the change is in `configuration.yaml`-loaded (YAML-mode) Lovelace, run `ha core check` then `ha core reload` (prefer reload over restart). Storage-mode dashboards update live — no reload needed.
2. Re-shoot the same path to the same output file.
3. Read the new PNG and compare against the goal. Repeat until correct.

## Interactive / stateful cases: Playwright MCP
Use when you must click, hover, toggle, open a dialog, wait for data, or capture a state `ha-shot` can't reach.

```
browser_navigate  → http://homeassistant:8123<path>   e.g. http://homeassistant:8123/lovelace/0
browser_snapshot        # accessibility tree — inspect structure / find elements
browser_take_screenshot # save PNG, then Read it
```

The browser is preinstalled. Navigate, interact (click/hover/wait), screenshot, then Read the PNG to evaluate. Prefer `ha-shot` for plain "show me this dashboard" — reach for Playwright only when interaction is required.

## Rules
- Always **Read the captured PNG** — a screenshot you don't look at proves nothing.
- Take a screenshot *after* any Lovelace edit to confirm it rendered.
- `ha-shot` failing with a token hint → HA Token add-on option is unset; do not fall back to guessing.
