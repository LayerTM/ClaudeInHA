# Changelog

## [1.7.3] — 2026-07-03

### Fixed
- **Chat answered "None" on the first real run.** With the MCP endpoint fixed in
  1.7.2 the Home Assistant `ha` server now connects (verified live), but the read
  tool (`GetLiveContext`) sometimes gets malformed tool-call JSON from the model
  and only recovers after several retries. The prompt server's 8-turn ceiling cut
  that recovery off mid-flight, so the run errored ("claude reported an error")
  and the chat showed nothing. Raised the per-run turn ceiling to 20 (the 120-second
  wall-clock timeout remains the real runaway bound) and steer the model toward a
  single `GetLiveContext` call with strictly-valid-JSON arguments — so chats now
  answer on the first try, faster and cheaper.

## [1.7.2] — 2026-07-03

### Fixed
- **Chat (the `claude_ha` integration) could not read Home Assistant.** The
  prompt server pointed its Home Assistant MCP connection at a non-existent
  endpoint (`/mcp_server/mcp`, which returns 404), so the `ha` MCP server never
  connected and every chat ran blind — no entity states, no live context — even
  with an HA token configured. Corrected to Home Assistant's real Model Context
  Protocol Server endpoint, `/api/mcp` (Streamable HTTP), and added a regression
  test that asserts it. For chat to see your home you still need the **Model
  Context Protocol Server** integration enabled in Home Assistant (Settings →
  Devices & services → Add integration → *Model Context Protocol Server*) with
  entities exposed to Assist.

### Changed
- **Console: prefer the configured `HA_TOKEN`.** Clarified the built-in guidance
  so the console assistant always uses the token from the *HA Token* option and
  never relies on stale hand-saved token files.

## [1.7.1] — 2026-07-03

### Changed
- **Clarified the OAuth Token option.** When a subscription OAuth token (from
  `claude setup-token`) is set, the console header shows "Claude API" — this only
  reflects token-based login and still bills against your subscription, not the
  pay-per-use API. Added a note to the field description (EN/UK/PL) so it no
  longer looks like a billing switch.

## [1.7.0] — 2026-07-03

### Added
- **Usage endpoint for the `claude_ha` integration.** The prompt API now serves
  `GET /api/usage` (same bearer auth) with Claude token totals (today / recent /
  all-time, per model) and the prompt-API dollar cost — the same data as
  `ha-usage`, as JSON, cached a few minutes. Lets the companion integration
  expose a usage sensor in Home Assistant. `ha-usage --json` produces the same
  report on the command line.

## [1.6.0] — 2026-07-03

Reliability, localization, and usage visibility.

### Added
- **Self-healing.** The Supervisor now watches the console and restarts the
  add-on automatically if the web server ever stops responding, and the add-on
  reports a health status you can see in its info page (Docker `HEALTHCHECK`).
- **`ha-usage`.** A new command that summarizes your Claude token usage —
  today, the last N days, and all-time, broken down per model — plus the
  prompt-API dollar cost from the audit log. Handy for keeping an eye on plan
  or API spend.
- **Ukrainian and Polish translations** of the configuration screen — the
  add-on options now show in your Home Assistant language (українська, polski)
  alongside English.

## [1.5.0] — 2026-07-03

Opens the add-on to the companion **Claude** (`claude_ha`) Home Assistant
integration — so you can talk to Claude from Assist and automations, not just
the console.

### Added
- **Secure Prompt API** for the `claude_ha` integration — a new,
  bearer-authenticated endpoint on an internal-only port (8126, never published
  to the host). It is built for running Claude on **untrusted** chat/automation
  input, so it is far more locked down than the console: every prompt runs a
  fresh, stateless, read-only Claude with deny-by-default tools (shell, file and
  web tools removed), **no Supervisor or Home Assistant credentials in the child
  environment**, Home Assistant access only through the Model Context Protocol
  Server integration (limited to Assist-exposed entities), and a two-phase
  model where a state change is proposed and only performed after explicit
  confirmation. Requests are rate-limited, concurrency-capped, time-bounded,
  output-capped, secret-redacted, and audited (`ha-audit`).
- **Zero-config pairing.** The add-on generates the API token and advertises
  itself (host, port, token) to the integration through Supervisor discovery —
  nothing to copy by hand.
- New options: `prompt_api` (on by default), `api_token` (optional fixed token),
  `prompt_ha_token` (optional dedicated HA token for a least-privilege user).

The interactive console (ingress) is unchanged; the Prompt API is a separate
listener with its own authentication.

## [1.4.2] — 2026-07-03

### Fixed
- **Safety backups now actually work.** The add-on lacked the Supervisor
  permission to create backups, so the backup-before-risky-change net (1.4.0)
  and `ha-backup` failed with 403. The add-on now requests the `manager` role,
  which also lets Claude manage add-ons via the Supervisor API. (Caught by
  live-testing on a real Home Assistant.)

## [1.4.1] — 2026-07-03

### Security
- **Hardened the opt-in proactive monitor.** It now fetches the HA error log
  itself and hands it to Claude as untrusted *data* to analyse — with no tools,
  no Home Assistant credentials in Claude's environment, and no permission
  bypass — so a prompt injection hidden in log output cannot trigger any action.
  (The monitor is off by default.)

## [1.4.0] — 2026-07-03

Safety, awareness, and more Home Assistant know-how.

### Added
- **Backup before risky changes.** Before a Home Assistant Core restart/stop/
  update, a destructive shell op in the config tree, or an edit to a config
  file, the add-on makes a focused HA-Core backup automatically — debounced, and
  it prunes its own old auto-backups so they never pile up. `ha-backup` is also
  there to call directly.
- **Action audit log.** Every service call, config edit, restart and backup
  Claude makes is recorded; review it any time with `ha-audit`.
- **Notifications.** `ha-notify "…"` pings you in Home Assistant (the bell by
  default) when a long task finishes; set `HA_NOTIFY_SERVICE=notify.mobile_app_<device>`
  in Environment Variables to push to a phone, which also enables needs-input pushes.
- **Proactive monitoring (opt-in).** Set `monitoring_interval_hours` > 0 and
  Claude periodically reviews the error log and configuration, notifying you only
  when it finds something worth flagging. Off by default (it spends plan usage).
- **Four more HA skills** — `/ha-energy` (consumption & cost), `/ha-recorder-query`
  (sensor history trends), `/ha-lovelace-card` (design a card with a live
  screenshot preview), `/ha-blueprint` (import and use blueprints).

## [1.3.1] — 2026-07-03

### Added
- **ImageMagick and Pillow bundled.** The console now ships `magick`
  (ImageMagick) and Python `Pillow` out of the box, so Claude can crop, resize
  and convert images — e.g. trimming a dashboard screenshot before reading it —
  with no per-session setup. Fills a gap hit in real use where only a
  hand-installed Pillow was available.

## [1.3.0] — 2026-07-02

Makes the console feel like a real desktop terminal — snappy, crisp, and with
the full status line.

### Changed
- **Status line is now `ccstatusline`** — the same tool the desktop Claude Code
  uses — bundled in the image and seeded with the rich three-line layout (model,
  thinking effort, reset/weekly timers, git root/branch/changes, version, free
  memory, token counts, input/output speed, a context-usage bar, session clock,
  cost, and session/weekly usage). Replaces the earlier minimal script. Seeded
  only when no status line is configured, so a custom one is never overwritten.
- **New "Terracotta Noir" theme.** A crisp near-black canvas with a faint cool
  undertone makes Claude's coloured output and the terracotta cursor read as
  vivid jewel tones instead of muddy pastels; the foreground jumps to a razor
  15:1. Refined chrome: calmer monochrome toolbar icons, a terracotta-underlined
  active tab, interior padding, and a sleek inset scrollbar.

### Fixed
- **Responsiveness — typing and scrolling now feel native.** Disabled Nagle on
  the terminal socket (`setNoDelay`), which was holding each keystroke's echo up
  to ~40 ms — the main "mushy" feel. Wheel scrolling is instant again (dropped
  the 100 ms animation) at a desktop-native line count. tmux now passes 24-bit
  truecolour through (it was downsampling to 256, banding colours), and the
  palette renders exactly as designed (`minimumContrastRatio` no longer silently
  brightens dim text). Scrollback no longer rubber-bands the parent HA page.

## [1.2.1] — 2026-07-02

### Fixed
- **Terminal occasionally clipped to 80 columns (content filling only the left
  side of the panel).** The console's initial resize could reach the server
  before the pty had finished spawning and was dropped, leaving the pty — and
  so the tmux window — stuck at its 80x24 spawn size while the client rendered
  full-width. Early resize and input are now buffered and applied once the pty
  is ready, and the pty spawns at the client's real size. Complements 1.2.0's
  instant client-side fit so the terminal is full-width end to end, every open.

## [1.2.0] — 2026-07-02

A console-feel release: the terminal now opens instantly at full size and looks
the part on every device.

### Added
- **Rich status line in the embedded Claude.** A bundled `cc-statusline` script
  surfaces model, reasoning effort, working directory (with a 🏠 marker for the
  HA config root), git branch and dirty state, context-window remaining, lines
  changed, and Pro/Max plan usage — the same kind of at-a-glance context the
  desktop Claude Code shows. Seeded into `~/.claude/settings.json` only when no
  status line is configured, so a custom one is never overwritten.
- **Bundled JetBrains Mono (OFL).** A crisp, consistent terminal font on every
  client, served locally (no runtime download). Paired with a refined,
  brand-warm 16-colour theme, block cursor, styled selection and scrollbar, and
  `minimumContrastRatio` so dim colours stay legible.

### Fixed
- **The terminal now fills the panel instantly — no more starting small and
  growing.** The previous release chased the resize with a ladder of timers,
  which still flashed the 80x24 default before settling. The terminal is now
  held hidden until it has been fitted to a real-sized container and the webfont
  has loaded, then revealed already at full size; a `ResizeObserver` drives
  every later fit so panel, window and key-bar resizes track in the same frame.
  No timers, no flash, no growing.

## [1.1.4] — 2026-07-02

### Fixed
- **Terminal not filling the panel right after the add-on (re)starts.** On the
  first render — while the HA panel iframe is still animating to full size and
  the WebSocket is reconnecting — `fit()` could run against a not-yet-sized
  container and stick the terminal at its 80x24 default. Fitting is now guarded
  against zero-size, re-run on several settle timers and on `body` resize, so
  the terminal reliably grows to fill the panel once layout settles.

## [1.1.3] — 2026-07-02

### Fixed
- **Blank console (no tabs, empty terminal) behind real Home Assistant ingress.**
  HA ingress resolves the panel's relative asset URLs with a leading double
  slash (`…/<token>//vendor/xterm.js`). The static assets survived (Express
  normalizes it) but the xterm vendor scripts were served by exact-match routes
  that did not, so they 404'd; with `X-Content-Type-Options: nosniff` the HTML
  404 body was refused as a script, `Terminal` was undefined, and the frontend
  threw before rendering. The server now collapses leading slashes for both HTTP
  and WebSocket requests, so every asset resolves regardless of the ingress
  path shape. Only reproduced through the real ingress proxy, not direct access.

## [1.1.2] — 2026-07-02

### Fixed
- **Blank console after upgrading from 0.2.x.** The 0.2.x images were
  Alpine-based, so the Claude binary persisted in `/data` was a musl build.
  `/data` survives add-on updates, and the first-run copy was skipped when
  `/data/home/.local` already existed — so on the Debian-based 1.x images that
  musl binary was kept and could not execute (`cannot execute: required file
  not found`), leaving Claude dead and the terminal blank. The add-on now
  verifies the persistent binary actually runs and re-installs it from the image
  when it does not (login and sessions in `~/.claude` are preserved). Fresh
  installs were unaffected, which is why this slipped through.

## [1.1.1] — 2026-07-02

### Changed
- **Graceful fallback for autonomous mode.** `bypass_permissions` relies on the
  undocumented `IS_SANDBOX` escape hatch to run `--dangerously-skip-permissions`
  as root. If a future Claude Code version stops honoring it, the add-on now
  detects that at startup (a credential-free pre-flight) and launches Claude
  *without* the flag plus a clear notice — instead of the Claude tab erroring.
  When the flag is accepted (the normal case) nothing changes.

## [1.1.0] — 2026-07-02

Turns the add-on into a zero-prep AI workstation for Home Assistant: the tools
Claude needs are preinstalled and pre-wired, so a fresh session is productive
immediately.

### Added
- **Browser testing built in.** Chromium (+ CJK/emoji fonts) is preinstalled;
  `ha-shot <dashboard-path> [out.png] [WxH]` captures an authenticated Lovelace
  dashboard to PNG, and a Playwright MCP server (`browser_navigate`,
  `browser_take_screenshot`, …) is registered for interactive browser work —
  both driving the system Chromium, no per-session install.
- **HA Token option (`ha_token`).** A Long-Lived Access Token, stored by the
  Supervisor so it persists across updates. When set it enables dashboard
  screenshots, `hass-cli`, the `hass-mcp` MCP server, and WebSocket/REST access
  as the user. Optional — everything else works without it.
- **Bundled Home Assistant skill pack**: `/ha-config-edit`, `/ha-automation`,
  `/ha-debug`, `/ha-entity`, `/ha-screenshot`, `/ha-backup`, `/ha-addon`,
  `/ha-onboard` — installed into the persistent config on first start.
- **Bundled general plugins** (Anthropic marketplaces): superpowers,
  frontend-design, skill-creator, security-guidance, context7, code-review,
  code-simplifier, feature-dev, commit-commands, claude-md-management, hookify,
  document-skills. Installed once and kept across updates.
- **Declarative extras**: `plugins`, `marketplaces`, and `skills_git` options
  to add your own plugins/marketplaces/skills on top of the bundled pack,
  reconciled on every start.
- **Preinstalled CLIs**: `ha` (Supervisor CLI), `yq` (YAML), `hass-cli`, plus
  `ha-check` and `ha-state` helpers, all documented in the built-in `CLAUDE.md`.

### Notes
- Provisioning runs in the background and is idempotent — it never blocks the
  console and only installs what is missing.
- The image is larger than 1.0.0 (bundled Chromium and tools).

## [1.0.0] — 2026-07-02

Complete rework: the ttyd terminal is replaced by a purpose-built web console
(Node.js + xterm.js 6) designed for HA ingress, plain-HTTP setups, and mobile
companion apps.

### Added
- **Tabs**: the Claude session plus any number of shell tabs. Exiting Claude
  opens a restart menu (restart / shell / update / resume) instead of killing
  the session.
- **Clipboard that works everywhere**: selection copies automatically
  (Shift+drag); the ⧉ menu copies the visible screen, recent output, or full
  history straight from tmux without selecting; OSC 52 copies from Claude
  itself are captured. When the browser blocks clipboard access (plain HTTP,
  Android WebView), copies land in a 📥 tray for one-tap manual copy.
- **File and image attachments**: drag & drop, clipboard image paste, and a
  file picker (camera/gallery on phones). Files are streamed to
  `/data/uploads` and the path is typed into Claude's prompt. Retention is
  configurable (`upload_retention_days`).
- **In-place CLI updates**: ⬆ toolbar button or `update-claude [version]` in
  any shell tab; only the Claude session restarts, never the add-on.
- **Mobile key bar** (Esc, Tab, ⇧Tab, ^C, arrows, /, @) and a full-screen
  kiosk toggle that hides the HA chrome.
- **Remote Control option** (`remote_control`): runs `claude remote-control`
  in an extra tab so the official Claude mobile app can drive the session.
- Automatic reconnect with session keep-alive; expired ingress sessions
  reload transparently.

### Changed
- Base image: Alpine → Debian 13 (eliminates musl-related breakage of the
  native Claude installer; better MCP/npm compatibility).
- `ingress_port` is now a fixed 8099; uploads stream through ingress
  (`ingress_stream` already enabled).
- tmux now runs with `allow-passthrough on` and `set-clipboard on` so
  Claude's own copy path reaches the browser.

### Removed
- ttyd (and its bundled xterm.js 5.x) — replaced by the built-in console.

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
  `rightClickSelectsWord=false` / `macOptionIsMeta=true` options added in
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
  never reached the browser clipboard — the OSC 52 forwarding attempt
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
