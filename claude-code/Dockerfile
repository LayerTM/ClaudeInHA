ARG BUILD_FROM
FROM ${BUILD_FROM} AS base

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV TERM=xterm-256color
# Authoritative truecolor signal: many TUIs (incl. Claude Code's renderer) gate
# 24-bit colour on COLORTERM=truecolor rather than the TERM string. The pipe
# already carries truecolor (tmux terminal-overrides ",*:Tc"); this lets apps
# actually use it. Inherited by the tmux server (spawned with process.env) and
# so by every window/shell.
ENV COLORTERM=truecolor
ENV LANG=C.UTF-8

# System packages:
# - build-essential python3: node-pty native build + npm packages with gyp deps
# - tmux: session persistence across browser disconnects
# - ripgrep: Claude Code search (USE_BUILTIN_RIPGREP=0)
# - remaining: general CLI tooling for Claude and MCP servers
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        build-essential \
        ca-certificates \
        curl \
        git \
        gnupg \
        jq \
        less \
        nano \
        openssh-client \
        procps \
        python3 \
        python3-pip \
        python3-venv \
        ripgrep \
        tmux \
        unzip \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Node.js from official dist tarballs (latest, deterministic, arch-aware).
# The SHA-256 of each platform's tarball is recorded beside the version, taken
# from that release's SHASUMS256.txt when the version is bumped (pins.py moves
# them together). The tarball is checked against the recorded value before it is
# unpacked, so a download that differs from what was seen at the bump — however
# it came to differ — stops the build instead of being installed.
# upstream: nodejs lts-ready
ARG NODE_VERSION=26.9.0
# upstream: nodejs-sha256 linux-x64
ARG NODE_SHA256_AMD64=c6ecd8efc1c1d395265891675319da7a7b3785c6be174bd78933cf4f057624d1
# upstream: nodejs-sha256 linux-arm64
ARG NODE_SHA256_ARM64=686d07ed3bc5d68d9f7bd4939b7e8849a87d0664ac19c8c5474474f44cc956db
RUN arch="$(dpkg --print-architecture)" \
    && case "${arch}" in \
         amd64) node_arch="x64";   expected="${NODE_SHA256_AMD64}" ;; \
         arm64) node_arch="arm64"; expected="${NODE_SHA256_ARM64}" ;; \
         *) echo "Unsupported architecture: ${arch}"; exit 1 ;; \
       esac \
    && tarball="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
    && { curl -fsSL --proto '=https' --retry 3 --retry-delay 2 -o "/tmp/${tarball}" \
           "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}" \
         || { echo "Could not download ${tarball}"; exit 1; }; } \
    && { echo "${expected}  /tmp/${tarball}" | sha256sum -c --strict - \
         || { echo "${tarball} does not match the recorded SHA-256 ${expected}"; exit 1; }; } \
    && tar -xJf "/tmp/${tarball}" -C /usr/local --strip-components=1 --no-same-owner \
    && rm -f "/tmp/${tarball}" \
    && node --version && npm --version

# --- ha-agent-core (pinned, checksum-verified) ---
# The console, the prompt server, tmux wiring and the shared helper scripts come
# from the ha-agent-core release pinned in core/core.lock.json. Only the lock
# chooses the URL and the expected SHA-256; core/verify-core.js is the reviewed
# copy kept in this repository, never the one inside the archive.
FROM base AS core-archive
COPY core/core.lock.json core/verify-core.js /tmp/core/
RUN url="$(node /tmp/core/verify-core.js url --lock /tmp/core/core.lock.json)" \
    && { curl -fsSL --proto '=https' --retry 3 --retry-delay 2 -o /core.tar "${url}" \
         || { echo "Could not download ha-agent-core from ${url}"; exit 1; }; }

# The add-on's own files plus the core, merged only after the archive matches the
# lock and neither side claims a path of the other (core/assemble.sh).
FROM base AS assembly
COPY core /tmp/core
COPY app /tmp/addon/app
COPY rootfs /tmp/addon/rootfs
COPY --from=core-archive /core.tar /tmp/core.tar
RUN /tmp/core/assemble.sh /tmp/core.tar /tmp/addon /addon

FROM base
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# --- Claude Code native binary (pinned, checksum-verified) ---
# Not `curl https://claude.ai/install.sh | bash`: that executes whatever the
# script says on the day of the build and always installs the CURRENT release
# (its optional version argument is passed to `claude install`, not to the
# download), so two builds of the same commit could ship different binaries and
# nothing was verified against a value this repository controls.
#
# The version and the SHA-256 of that version's binary for each platform are
# recorded below, taken from the release's manifest.json when the version is
# bumped. Recording them here is the point: reading the checksum from the same
# host at build time — which an earlier draft of this did — proves only that the
# binary agrees with a manifest published beside it, and a republished pair of
# both would pass. Against a value in this repository it cannot.
#
# What that does and does not promise: no script from the network is executed,
# and nothing downloaded runs before it matches the recorded checksum. The
# pinned binary itself is then executed once, for `--version` — the layout
# assertion below — which is the only thing from the network that runs at all.
#
# The layout below is the one `claude install` produces and the one the add-on's
# service script depends on (it copies ~/.local wholesale and re-points the
# persistent copy): the real binary under share/claude/versions/<version>, with
# bin/claude a symlink to it. Both are asserted after the install, so an upstream
# change of shape fails the build here instead of at a user's next start.
#
# A detached PGP signature of the manifest is also published, at
# <version>/manifest.json.sig. It is deliberately NOT used: verifying it needs
# Anthropic's public key from a channel whose trust could be established, and
# fetching the key from the same bucket would prove nothing. If that key gets a
# documented home, it belongs here: it would let a bump verify that a new version
# is authentic, where a recorded checksum can only hold it to what was seen.
# upstream: claude-code CLAUDE_DOWNLOAD_BASE latest
ARG CLAUDE_CODE_VERSION=2.1.275
# From <version>/manifest.json: .platforms["linux-x64"].checksum and
# .platforms["linux-arm64"].checksum. A version bump moves these two with it;
# forgetting stops the build at the checksum rather than at a user's next start.
# upstream: claude-code-sha256 linux-x64
ARG CLAUDE_CODE_SHA256_AMD64=13586f3150a7ca1655f36e1dba759fb404e0f7cf7021d4a3dcd5e6f604e56156
# upstream: claude-code-sha256 linux-arm64
ARG CLAUDE_CODE_SHA256_ARM64=efcefb7448c3d12a045b5c53e0fb4e8859ff99abe90d67f83900c4f0ffd517ed
ARG CLAUDE_DOWNLOAD_BASE=https://downloads.claude.ai/claude-code-releases
# Every fallible step carries its own message. In a single `A && B && C || D`
# chain the `||` binds to the WHOLE chain, so the first failure jumps straight to
# the last handler: a fetch that failed printed "Pinned 9.9.9 but the binary
# reports ''" — true that the build failed, wrong about why. Each guard is braced
# so it can only fire for its own step.
RUN arch="$(dpkg --print-architecture)" \
    && case "${arch}" in \
         amd64) claude_platform="linux-x64";   expected="${CLAUDE_CODE_SHA256_AMD64}" ;; \
         arm64) claude_platform="linux-arm64"; expected="${CLAUDE_CODE_SHA256_ARM64}" ;; \
         *) echo "Unsupported architecture: ${arch}"; exit 1 ;; \
       esac \
    && claude_bin="/root/.local/share/claude/versions/${CLAUDE_CODE_VERSION}" \
    && { [ "${#expected}" -eq 64 ] \
         || { echo "Recorded checksum for ${claude_platform} is not 64 characters: '${expected}' — bump it with the version"; exit 1; }; } \
    && case "${expected}" in \
         *[!0-9a-f]*) echo "Recorded checksum for ${claude_platform} is not hex: '${expected}'"; exit 1 ;; \
       esac \
    && mkdir -p /root/.local/share/claude/versions /root/.local/bin \
    && { curl -fsSL --retry 3 --retry-delay 2 -o "${claude_bin}" \
           "${CLAUDE_DOWNLOAD_BASE}/${CLAUDE_CODE_VERSION}/${claude_platform}/claude" \
         || { echo "Could not download Claude Code ${CLAUDE_CODE_VERSION} for ${claude_platform}"; exit 1; }; } \
    && { printf '%s  %s\n' "${expected}" "${claude_bin}" | sha256sum -c - \
         || { echo "Claude Code ${CLAUDE_CODE_VERSION} for ${claude_platform} does not match the checksum recorded in this repository"; exit 1; }; } \
    && chmod +x "${claude_bin}" \
    && ln -sfn "${claude_bin}" /root/.local/bin/claude \
    && { [ "$(readlink /root/.local/bin/claude)" = "${claude_bin}" ] \
         || { echo "Launcher symlink does not point at ${claude_bin}"; exit 1; }; } \
    && installed="$(/root/.local/bin/claude --version | awk '{print $1}')" \
    && { [ "${installed}" = "${CLAUDE_CODE_VERSION}" ] \
         || { echo "Pinned ${CLAUDE_CODE_VERSION} but the binary reports '${installed}'"; exit 1; }; }

ENV PATH="/root/.local/bin:${PATH}"
ENV USE_BUILTIN_RIPGREP=0

# Claude Code refuses --dangerously-skip-permissions under root unless it
# detects a sandbox. HA add-ons run as root in an isolated container.
ENV IS_SANDBOX=1

# --- Browser + image tooling for dashboard screenshots ---
# System Chromium (apt resolves all its runtime deps; works amd64 + arm64) plus
# CJK/emoji/base fonts so dashboards don't render tofu boxes. Both the ha-shot
# helper and Playwright MCP point at /usr/bin/chromium (no bundled download).
# ImageMagick gives Claude a native CLI (`magick`) for cropping/resizing those
# screenshots (Pillow, below, covers the Python side).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        fonts-noto-cjk \
        fonts-noto-color-emoji \
        fonts-liberation \
        imagemagick \
    && rm -rf /var/lib/apt/lists/*
ENV CHROME_BIN=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# --- Home Assistant CLIs (static, arch-aware) ---
# upstream: github-release home-assistant/cli
ARG HA_CLI_VERSION=5.5.0
# upstream: github-release mikefarah/yq
ARG YQ_VERSION=4.53.6
RUN arch="$(dpkg --print-architecture)" \
    && case "${arch}" in \
         amd64) ha_asset=ha_amd64; yq_asset=yq_linux_amd64 ;; \
         arm64) ha_asset=ha_aarch64; yq_asset=yq_linux_arm64 ;; \
         *) echo "Unsupported architecture: ${arch}" && exit 1 ;; \
       esac \
    && curl -fsSL --retry 3 --retry-delay 2 "https://github.com/home-assistant/cli/releases/download/${HA_CLI_VERSION}/${ha_asset}" -o /usr/bin/ha \
    && curl -fsSL --retry 3 --retry-delay 2 "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/${yq_asset}" -o /usr/local/bin/yq \
    && chmod +x /usr/bin/ha /usr/local/bin/yq \
    && ha help >/dev/null && yq --version

# home-assistant-cli (hass-cli) + hass-mcp (registered as an MCP server when
# the HA Token is set): entity/service queries against the Core API.
# Pillow: Python imaging for ad-hoc crops/resizes of dashboard screenshots
# (ImageMagick's `magick` covers the CLI side).
# upstream: pypi homeassistant-cli
ARG HASS_CLI_VERSION=1.0.0
# upstream: pypi hass-mcp
ARG HASS_MCP_VERSION=0.6.0
# upstream: pypi Pillow
ARG PILLOW_VERSION=12.3.0
RUN pip install --no-cache-dir --break-system-packages \
        "homeassistant-cli==${HASS_CLI_VERSION}" \
        "hass-mcp==${HASS_MCP_VERSION}" \
        "Pillow==${PILLOW_VERSION}"

# Force HTTPS for GitHub clones (plugin marketplaces) — the container has no SSH key.
RUN git config --system url."https://github.com/".insteadOf "git@github.com:"

# Dependencies are installed with the core's checked install: only the reviewed
# install scripts run (node-pty compiles against the headers of the Node
# installed above, nothing is downloaded), and dev dependencies stay out.
COPY --from=assembly /addon/install-tools /usr/local/lib/install-tools

# Bundled command-line tools, installed from cli-tools/package-lock.json with the
# same checked install, and each command they declare linked into /usr/local/bin:
# - @playwright/mcp (playwright-mcp): browser MCP server; it uses the system
#   Chromium via --executable-path at runtime, no browser is downloaded.
# - ccstatusline: the rich status line the desktop Claude Code uses, wired as
#   Claude's statusLine, so nothing is fetched with npx at runtime.
# Their versions live in cli-tools/package.json and move with pins.py.
COPY cli-tools /opt/cli-tools
RUN cd /opt/cli-tools \
    && /usr/local/lib/install-tools/npm-ci-checked.sh --omit=dev \
    && npm cache clean --force \
    && for dep in $(jq -r '.dependencies | keys[]' package.json); do \
         jq -r 'if (.bin | type) == "string" then .name | split("/") | last else .bin | keys[] end' \
           "node_modules/${dep}/package.json" \
           || { echo "Cannot read the commands of ${dep}" >&2; exit 1; }; \
       done \
     | while read -r cmd; do \
         { test -x "node_modules/.bin/${cmd}" && test ! -e "/usr/local/bin/${cmd}"; } \
           || { echo "Cannot link ${cmd}: missing in node_modules/.bin or already in /usr/local/bin"; exit 1; }; \
         ln -s "/opt/cli-tools/node_modules/.bin/${cmd}" "/usr/local/bin/${cmd}"; \
       done \
    && test -x /usr/local/bin/playwright-mcp \
    && test -x /usr/local/bin/ccstatusline

# Web console app. The terminal font (JetBrains Mono, OFL) comes from the
# core's own @fontsource/jetbrains-mono dependency, installed below; nothing
# fetches it separately.
COPY --from=assembly /addon/app /opt/agent-console
RUN cd /opt/agent-console \
    && /usr/local/lib/install-tools/npm-ci-checked.sh --omit=dev \
    && npm cache clean --force

# ha-shot helper dependencies (playwright-core drives the system Chromium)
COPY --from=assembly /addon/ha-tools /opt/ha-tools
RUN cd /opt/ha-tools \
    && /usr/local/lib/install-tools/npm-ci-checked.sh --omit=dev \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/install-tools

# Bundled Home Assistant skill pack (seeded into ~/.claude/skills on first run)
COPY skills /opt/ha-skills

# S6 services, scripts, default CLAUDE.md
COPY --from=assembly /addon/rootfs /

RUN chmod +x /etc/s6-overlay/s6-rc.d/claude-code/run \
             /etc/s6-overlay/s6-rc.d/claude-code/finish \
             /usr/local/bin/addon-run \
             /usr/local/bin/agent-ask \
             /usr/local/bin/agent-usage \
             /usr/local/bin/start-claude \
             /usr/local/bin/start-remote \
             /usr/local/bin/update-claude \
             /usr/local/bin/provision-extras \
             /usr/local/bin/cc-monitor \
             /usr/local/bin/cc-digest \
             /usr/local/bin/cc-alerts \
             /usr/local/bin/cc-statusline-width \
             /usr/local/bin/cc-hook-backup \
             /usr/local/bin/cc-hook-audit \
             /usr/local/bin/cc-hook-notify \
             /usr/local/bin/ha-shot \
             /usr/local/bin/ha-check \
             /usr/local/bin/ha-state \
             /usr/local/bin/ha-notify \
             /usr/local/bin/ha-backup \
             /usr/local/bin/ha-audit \
             /usr/local/bin/ha-usage

# Surface console health to the Supervisor. Hits the loopback health endpoint
# (allowed by the console's IP guard); marks the add-on unhealthy if the Node
# console stops responding. Generous start period covers first-run home setup.
# Exec form: no shell needed, and Docker already treats every non-zero probe
# exit (curl's 7 refused / 22 HTTP error / 28 timeout) as unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD ["curl", "-fsS", "http://127.0.0.1:8099/api/health"]

LABEL \
    io.hass.name="Claude Code" \
    io.hass.description="Claude Code AI assistant for Home Assistant" \
    io.hass.type="addon"
