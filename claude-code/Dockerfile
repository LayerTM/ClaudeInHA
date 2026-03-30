ARG BUILD_FROM
FROM ${BUILD_FROM}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV TERM=xterm-256color
ENV LANG=C.UTF-8

# System packages
# - bash curl git jq: essentials
# - libgcc libstdc++ ncurses: required by Claude Code native binary on Alpine (musl)
# - nodejs npm: MCP servers, plugins, skills that use npm packages
# - openssh-client: git over SSH
# - python3 py3-pip: Python-based MCP servers
# - ripgrep: Claude Code search (USE_BUILTIN_RIPGREP=0 uses this instead of bundled)
# - tmux: session persistence (browser disconnect doesn't kill Claude session)
# - ttyd: web terminal server (same as hassio-addons/addon-ssh)
RUN apk add --no-cache \
    bash \
    curl \
    git \
    jq \
    libgcc \
    libstdc++ \
    ncurses \
    nodejs \
    npm \
    openssh-client \
    python3 \
    py3-pip \
    ripgrep \
    tmux \
    ttyd

# Install Claude Code native binary (supports linux-x64-musl and linux-arm64-musl)
# Installed to /root/.local/bin/claude — will be copied to persistent /data/home at runtime
ENV HOME=/root
RUN curl -fsSL https://claude.ai/install.sh | bash

ENV PATH="/root/.local/bin:${PATH}"
ENV USE_BUILTIN_RIPGREP=0

# Copy rootfs (S6 services, scripts, default CLAUDE.md)
COPY rootfs /

# Make all scripts executable
RUN find /etc/s6-overlay/s6-rc.d -name "run" -exec chmod +x {} \; \
    && find /etc/s6-overlay/s6-rc.d -name "finish" -exec chmod +x {} \; \
    && chmod +x /usr/local/bin/start-claude

LABEL \
    io.hass.name="Claude Code" \
    io.hass.description="Claude Code AI assistant for Home Assistant" \
    io.hass.type="addon"
