'use strict';

// The Claude Code engine adapter for ha-agent-core: every value the core needs
// that is specific to Claude. The core loads it through server/adapter-contract.js.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const runner = require('./runner');

// Where the access token is sent.
// Fixed, deliberately not overridable: the add-on exports every
// `environment_vars` entry into this process, so an override would let one
// pasted config line ship the credential to any host.
const LIMITS_URL = 'https://api.anthropic.com/api/oauth/usage';

module.exports = {
  apiVersion: 1,
  runner: {
    run: runner.runClaude,
    shutdown: runner.shutdown,
    safeLangTag: runner.safeLangTag,
    TIMEOUT_MS: runner.TIMEOUT_MS,
  },
  prompt: {
    // The OAuth access token as the CLI keeps it: the pasted `oauth_token` option
    // (or its environment variable) first, otherwise the credential file an
    // interactive `claude` login writes.
    limitsCredential({ oauthToken, homeDir }) {
      if (oauthToken) return oauthToken;
      try {
        const stored = JSON.parse(fs.readFileSync(`${homeDir}/.claude/.credentials.json`, 'utf8'));
        const saved = stored && stored.claudeAiOauth && stored.claudeAiOauth.accessToken;
        return typeof saved === 'string' ? saved : '';
      } catch {
        return '';
      }
    },
    fetchLimits(accessToken, limitsFetch) {
      return limitsFetch(LIMITS_URL, {
        headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
        signal: AbortSignal.timeout(10000),
      });
    },
    // One upstream entry → one contract entry (unknown `kind` passes through; a
    // `kind` or `percent` that is not what it claims makes the payload unparsable).
    limitEntry(item) {
      if (!item || typeof item !== 'object') return null;
      if (typeof item.kind !== 'string' || !Number.isFinite(item.percent)) return null;
      const percent = Math.round(item.percent);
      if (percent < 0 || percent > 100) return null;
      const modelName = item.scope && item.scope.model && item.scope.model.display_name;
      return {
        kind: item.kind,
        percent,
        severity: typeof item.severity === 'string' ? item.severity : null,
        resets_at: typeof item.resets_at === 'string' ? item.resets_at : null,
        model: typeof modelName === 'string' ? modelName : null,
      };
    },
    authConfigured({ env, home }) {
      return env.ANTHROPIC_API_KEY
        || env.CLAUDE_CODE_OAUTH_TOKEN
        || fs.existsSync(`${home}/.claude/.credentials.json`);
    },
    async writeMcpConfig({ dir, url, bearer }) {
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, 'ha-mcp.json');
      if (!url || !bearer) {
        await fsp.rm(file, { force: true });
        return null;
      }
      const config = {
        mcpServers: {
          ha: {
            type: 'http',
            url,
            headers: { Authorization: `Bearer ${bearer}` },
          },
        },
      };
      await fsp.writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 });
      return file;
    },
    hasAuditHook(raw) {
      try {
        const post = JSON.parse(raw).hooks.PostToolUse;
        return Array.isArray(post) && post.some((entry) => Array.isArray(entry?.hooks)
          && entry.hooks.some((h) => typeof h?.command === 'string' && h.command !== ''));
      } catch {
        return false;
      }
    },
    async removeSavedSessions(homeDir, workDir) {
      const dir = path.join(homeDir, '.claude', 'projects', workDir.replace(/[^A-Za-z0-9]/g, '-'));
      let entries;
      try {
        entries = await fsp.readdir(dir);
      } catch (err) {
        if (err.code === 'ENOENT') return 0;
        throw err;
      }
      await fsp.rm(dir, { recursive: true, force: true });
      return entries.filter((name) => name.endsWith('.jsonl')).length;
    },
    credentials({ options, env, optionString }) {
      return {
        apiKey: optionString(options, 'api_key') || env.ANTHROPIC_API_KEY || '',
        oauthToken: optionString(options, 'oauth_token') || env.CLAUDE_CODE_OAUTH_TOKEN || '',
      };
    },
    secretValues({ options, env, optionString }) {
      return {
        options: [optionString(options, 'api_key'), optionString(options, 'oauth_token')],
        env: [env.ANTHROPIC_API_KEY, env.CLAUDE_CODE_OAUTH_TOKEN],
      };
    },
  },
  console: {
    bin: '/data/home/.local/bin/claude',
    updateCommand: '/usr/local/bin/update-claude',
    windowName: 'claude',
    launcher: '/usr/local/bin/start-claude',
    // Official Anthropic Remote Control: its own tab so the session URL and QR
    // code render in a real terminal.
    remoteWindow(env) {
      return env.REMOTE_CONTROL === 'true' ? { name: 'remote', argv: ['/usr/local/bin/start-remote'] } : null;
    },
  },
};
