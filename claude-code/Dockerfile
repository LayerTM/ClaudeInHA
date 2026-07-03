ARG BUILD_FROM
FROM ${BUILD_FROM}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV TERM=xterm-256color
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

# Node.js LTS from official dist tarballs (deterministic, arch-aware)
ARG NODE_VERSION=24.18.0
RUN arch="$(dpkg --print-architecture)" \
    && case "${arch}" in \
         amd64) node_arch="x64" ;; \
         arm64) node_arch="arm64" ;; \
         *) echo "Unsupported architecture: ${arch}" && exit 1 ;; \
       esac \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
       | tar -xJ -C /usr/local --strip-components=1 --no-same-owner \
    && node --version && npm --version

# Claude Code native binary.
# Installed to /root/.local/bin/claude — copied to persistent /data/home at runtime.
# HOME is set inline for this RUN only (not as ENV) so s6's container_environment
# does not bake HOME=/root in and override the persistent HOME=/data/home.
RUN HOME=/root curl -fsSL https://claude.ai/install.sh | bash \
    && /root/.local/bin/claude --version   # fail the build if the binary can't run on this base

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
ARG HA_CLI_VERSION=5.2.0
ARG YQ_VERSION=4.53.3
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
ARG HASS_CLI_VERSION=1.0.0
ARG HASS_MCP_VERSION=0.5.0
ARG PILLOW_VERSION=12.3.0
RUN pip install --no-cache-dir --break-system-packages \
        "homeassistant-cli==${HASS_CLI_VERSION}" \
        "hass-mcp==${HASS_MCP_VERSION}" \
        "Pillow==${PILLOW_VERSION}"

# --- Playwright MCP (baked, pinned) ---
# Uses the system Chromium via --executable-path at runtime; no browser download.
ARG PLAYWRIGHT_MCP_VERSION=0.0.77
RUN npm install -g "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
    && npm cache clean --force

# --- ccstatusline (the rich status line the desktop Claude Code uses) ---
# Bundled so no runtime npx download is needed; wired as Claude's statusLine.
ARG CCSTATUSLINE_VERSION=2.2.22
RUN npm install -g "ccstatusline@${CCSTATUSLINE_VERSION}" \
    && npm cache clean --force

# Force HTTPS for GitHub clones (plugin marketplaces) — the container has no SSH key.
RUN git config --system url."https://github.com/".insteadOf "git@github.com:"

# Web console app
COPY app /opt/claude-console
RUN cd /opt/claude-console \
    && npm ci --omit=dev \
    && npm cache clean --force

# Bundled terminal font (JetBrains Mono, OFL) — crisp, consistent glyphs across
# every client, served locally so nothing is fetched at runtime.
ARG JETBRAINS_MONO_VERSION=5.2.8
RUN mkdir -p /opt/claude-console/public/fonts \
    && curl -fsSL --retry 3 --retry-delay 2 \
        "https://cdn.jsdelivr.net/npm/@fontsource/jetbrains-mono@${JETBRAINS_MONO_VERSION}/files/jetbrains-mono-latin-400-normal.woff2" \
        -o /opt/claude-console/public/fonts/jetbrains-mono-400.woff2 \
    && curl -fsSL --retry 3 --retry-delay 2 \
        "https://cdn.jsdelivr.net/npm/@fontsource/jetbrains-mono@${JETBRAINS_MONO_VERSION}/files/jetbrains-mono-latin-700-normal.woff2" \
        -o /opt/claude-console/public/fonts/jetbrains-mono-700.woff2

# ha-shot helper dependencies (playwright-core drives the system Chromium)
COPY ha-tools /opt/ha-tools
RUN cd /opt/ha-tools \
    && npm ci --omit=dev \
    && npm cache clean --force

# Bundled Home Assistant skill pack (seeded into ~/.claude/skills on first run)
COPY skills /opt/ha-skills

# S6 services, scripts, default CLAUDE.md
COPY rootfs /

RUN chmod +x /etc/s6-overlay/s6-rc.d/claude-code/run \
             /etc/s6-overlay/s6-rc.d/claude-code/finish \
             /usr/local/bin/start-claude \
             /usr/local/bin/start-remote \
             /usr/local/bin/update-claude \
             /usr/local/bin/provision-extras \
             /usr/local/bin/cc-monitor \
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
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8099/api/health || exit 1

LABEL \
    io.hass.name="Claude Code" \
    io.hass.description="Claude Code AI assistant for Home Assistant" \
    io.hass.type="addon"
