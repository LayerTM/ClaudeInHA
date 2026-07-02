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
RUN HOME=/root curl -fsSL https://claude.ai/install.sh | bash

ENV PATH="/root/.local/bin:${PATH}"
ENV USE_BUILTIN_RIPGREP=0

# Claude Code refuses --dangerously-skip-permissions under root unless it
# detects a sandbox. HA add-ons run as root in an isolated container.
ENV IS_SANDBOX=1

# Web console app
COPY app /opt/claude-console
RUN cd /opt/claude-console \
    && npm ci --omit=dev \
    && npm cache clean --force

# S6 services, scripts, default CLAUDE.md
COPY rootfs /

RUN chmod +x /etc/s6-overlay/s6-rc.d/claude-code/run \
             /etc/s6-overlay/s6-rc.d/claude-code/finish \
             /usr/local/bin/start-claude \
             /usr/local/bin/start-remote \
             /usr/local/bin/update-claude

LABEL \
    io.hass.name="Claude Code" \
    io.hass.description="Claude Code AI assistant for Home Assistant" \
    io.hass.type="addon"
