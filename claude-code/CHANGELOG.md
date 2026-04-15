# Changelog

## [0.2.5] — 2026-04-14

### Changed
- **Mouse wheel now scrolls terminal history.** `/etc/tmux.conf`
  ships with `set -g mouse on` and `history-limit 50000`, so wheel
  events scroll through 50k lines of tmux scrollback instead of
  being silently swallowed by Claude's mouse tracking.
- **Selection now uses `Shift+drag`.** With `mouse on`, plain drag
  and right-click are consumed by tmux / Claude, but xterm.js's
  `SelectionService.shouldForceSelection()` short-circuits CSI
  forwarding whenever Shift is held on non-Mac
  (`Terminal.ts:780`). So `Shift+drag` still produces a native
  browser selection that `Ctrl+Shift+C` copies, and
  `Shift+right-click` still opens the browser context menu.
- **xterm.js scrollback bumped from 1000 to 10000 lines**
  (`-t scrollback=10000`). tmux owns the long history, but
  xterm.js's own scrollback is what `Shift+PageUp` and the wheel
  draw on directly; the previous 1000-line default filled too
  quickly.
- Welcome banner reorganised into a single **Mouse / clipboard**
  section listing wheel / copy / paste / Shift-bypass /
  right-click / clickable URLs / OPEN WEB UI escape hatch.

This re-enables `set -g mouse on`, which was removed in v0.2.2
because plain drag landed in tmux's copy-mode buffer with no
fallback. v0.2.5 keeps `mouse on` and relies on xterm.js's
existing Shift-modifier bypass for browser-side selection — that
path was always present, just unused.

## [0.2.4] — 2026-04-14

### Fixed
- **Copy from the terminal works reliably across browsers.** ttyd is
  launched with `-t rendererType=dom` (xterm.js DOM renderer) instead
  of ttyd 1.7.7's hardcoded WebGL default. With WebGL, xterm.js
  paints terminal text to a canvas and `window.getSelection()`
  returns only an accessibility-layer proxy of the visible text;
  ttyd's copy-on-select path (`document.execCommand('copy')` on
  `terminal.onSelectionChange`) then silently no-ops in browsers
  that exclude that proxy from real selections — notably the HA
  Android app WebView. The DOM renderer emits real text spans, so
  native browser selection, `Ctrl+Shift+C`, and right-click Copy
  all behave normally.
- **Paste at Claude's prompts works.** Added
  `-t ignoreBracketedPasteMode=true` so xterm.js sends pasted text
  as raw bytes instead of wrapping it in DECSET 2004 escapes
  (`\e[200~…\e[201~`). With the wrapping, paste at Claude's
  interactive prompts produced no output at all; the flag restores
  `Cmd+V` / `Ctrl+Shift+V` for the OAuth code and regular input.
  Side effect: `bash`/`zsh` no longer distinguish pasted text from
  typing (multi-line shell paste executes line-by-line) and `vim`
  loses paste autodetect — use `:set paste` manually if needed.

### Changed
- Welcome banner documents two xterm.js behaviors users will hit
  inside Claude:
  - **Mouse tracking.** Claude enables DECSET 1000/1002/1003, so a
    plain drag or right-click inside Claude is forwarded to Claude
    rather than starting a browser selection or opening the browser
    context menu. Hold `Shift` to override: `Shift+drag` selects
    text, `Shift+right-click` opens the browser context menu
    (Copy / Paste).
  - **Focus for `Ctrl+Shift+V`.** xterm.js's hidden textarea needs
    keyboard focus to receive the paste event — click in the
    terminal first after switching tabs to copy an OAuth code.

## [0.2.3] — 2026-04-14

### Fixed
- In-terminal authentication via `claude` (the classic login flow) is usable
  again in the HA sidebar. The `-t copyOnSelect=true` / `cursorBlink=true` /
  `rightClickSelectsWord=false` / `macOptionIsMeta=true` options I added in
  v0.2.1 were either silently ignored (there is no `copyOnSelect` in ttyd or
  xterm.js) or interfered with how the HA ingress iframe proxies mouse
  events and clipboard permissions. Combined with the bundled
  `/etc/tmux.conf` (added at the same time), the result was that selecting
  text did not copy and pasting the OAuth code failed. Both are now gone —
  the ttyd invocation is back to the minimal v0.1.x form and tmux runs on
  its own defaults.

### Changed
- Welcome banner in the tmux session now documents the actual working
  shortcuts (`Ctrl+Shift+C` / `Ctrl+Shift+V`, right-click, clickable URLs)
  and points at "OPEN WEB UI" as the escape hatch when the sidebar iframe
  misbehaves in a given browser.
- When no credentials are configured and no prior login exists on disk, the
  banner prints a short two-option first-time-setup guide before dropping
  the user at the shell — so the login step is not a guessing game.

## [0.2.2] — 2026-04-14

### Fixed
- Mouse selection now actually copies to the browser clipboard. v0.2.1
  shipped `set -g mouse on` in the bundled tmux config, which made tmux
  intercept every mouse event before xterm.js could see it. The result
  was that drag-to-select went into tmux's internal copy-mode buffer and
  never reached the browser clipboard — the OSC 52 forwarding I tried
  also had double-escaped backslashes in `terminal-overrides`, so even
  that path was broken. The fix is simpler: leave tmux's mouse off and
  let xterm.js handle selection natively. With ttyd's `copyOnSelect=true`
  (shipped in v0.2.1), drag-to-select now copies straight to the
  browser clipboard, and right-click falls through to the browser's
  context menu (so paste works there too).

## [0.2.1] — 2026-04-14

### Added
- `oauth_token` config option — paste a long-lived OAuth token generated by
  `claude setup-token` (on any machine with a normal browser) to skip
  interactive login inside the HA ingress terminal entirely. Exported as
  `CLAUDE_CODE_OAUTH_TOKEN` at startup. Valid ~1 year, subscription-based.
- `/etc/tmux.conf` with mouse support, clipboard forwarding (OSC 52),
  50k-line scrollback, and zero escape-time. Users can still override in
  `~/.tmux.conf`.
- ttyd flags for better terminal UX:
  - `copyOnSelect=true` — selecting text with the mouse auto-copies it,
    which fixes OAuth URLs copying as mangled multi-line strings.
  - `cursorBlink=true`, `macOptionIsMeta=true`, `rightClickSelectsWord=false`
    (so the browser's right-click context menu / paste still works).

### Changed
- DOCS.md now recommends the `oauth_token` path for subscription users and
  documents the HA-ingress-iframe clipboard quirk plus the "open in new tab"
  workaround.

## [0.2.0] — 2026-04-14

### Fixed
- `--dangerously-skip-permissions` now works inside the add-on. Recent Claude
  Code versions refuse the flag when the process runs as root; the container
  now exports `IS_SANDBOX=1` so Claude recognizes the container as a sandbox
  and allows the flag.
- Claude version no longer "rolls back" after HA or add-on updates. On every
  startup the add-on compares the Claude binary bundled in the image with the
  one in persistent storage (`/data/home/.local/bin/claude`) and syncs the
  newer one. Previously, the persistent binary was only seeded on first run,
  so a newer bundled binary from an image rebuild was never picked up.
- Authentication (`claude auth login`) now persists across container restarts.
  The Dockerfile previously set `ENV HOME=/root`, which s6-overlay copied into
  the container environment. The `with-contenv` shebang on `start-claude`
  re-loaded that HOME, overriding the `HOME=/data/home` export from the parent
  `run` script. As a result, Claude was writing OAuth tokens and session state
  to `/root/.claude/` (ephemeral) instead of `/data/home/.claude/` (persistent).
  HOME is now set inline during build only (not as `ENV`), and `start-claude`
  explicitly re-exports `HOME=/data/home` as a defensive measure. This also
  fixes `claude --resume` and session history persistence.

### Added
- `extra_args` option: extra CLI arguments appended to the default `claude`
  invocation (one per entry).
- `launch_command` option: full command string that replaces the default
  `claude` invocation when set (escape hatch for advanced customization).

## [0.1.1] — 2026-03-30

- Version bump to force HA image rebuild.

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
