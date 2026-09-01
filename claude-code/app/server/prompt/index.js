'use strict';

// Bootstrap for the prompt server (the add-on side of the claude_ha bridge):
// load options, provision the bearer token, write the scoped HA MCP config,
// bind 0.0.0.0:<port> (internal docker network only — the port is NOT in the
// add-on's `ports:`, so it is never published to the host), then announce
// host/port/token to the Supervisor discovery API for the integration.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPromptApp } = require('./server');
const { buildRedactor } = require('./security');
const runner = require('./runner');
const { resolveCoreTarget } = require('./core-target');
const { startCoreRelay } = require('./core-relay');

const PORT = Number(process.env.CLAUDE_PROMPT_PORT || 8126);
const DEV = process.env.CLAUDE_PROMPT_DEV === '1';
const DATA_DIR = process.env.CLAUDE_PROMPT_DATA || '/data';
const OPTIONS_FILE = process.env.CLAUDE_PROMPT_OPTIONS || '/data/options.json';
const CLAUDE_BIN = process.env.CLAUDE_PROMPT_BIN || '/data/home/.local/bin/claude';
const USAGE_BIN = process.env.CLAUDE_PROMPT_USAGE_BIN || '/usr/local/bin/ha-usage';
// Dev/test escape hatch only. In the add-on the startup script unsets it after
// applying user environment_vars, so it can never be set from the config — the
// Core address is derived (see core-target.js), never supplied.
const HA_MCP_URL_OVERRIDE = process.env.CLAUDE_PROMPT_HA_MCP_URL || '';
const DISCOVERY_SERVICE = 'claude_ha';

function log(msg) {
  console.log(`[prompt] ${msg}`);
}

function readOptions() {
  try {
    const parsed = JSON.parse(fs.readFileSync(OPTIONS_FILE, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function optionString(options, key) {
  const value = options[key];
  return typeof value === 'string' ? value.trim() : '';
}

// Bearer token: the user-set `api_token` option wins; otherwise a 32-byte
// url-safe token is generated once and persisted across restarts/updates.
async function loadToken(options) {
  const configured = optionString(options, 'api_token');
  if (configured) return configured;
  const file = path.join(DATA_DIR, 'claude-prompt-token');
  try {
    const existing = (await fsp.readFile(file, 'utf8')).trim();
    if (existing.length >= 16) return existing;
  } catch { /* first boot */ }
  const token = crypto.randomBytes(32).toString('base64url');
  await fsp.writeFile(file, `${token}\n`, { mode: 0o600 });
  log('generated new prompt-API token');
  return token;
}

// The MCP config the spawned Claude reads (0600). It points at the loopback
// relay and carries the per-boot RELAY token — not the Home Assistant one, which
// now stays in this process (see core-relay.js). The relay is what talks to
// Core, so this hop is plain HTTP on 127.0.0.1 and needs no TLS handling from a
// client we do not control. Assist entity exposure remains the outer capability
// ceiling. Never the Supervisor token.
async function writeMcpConfig(url, bearer) {
  const dir = path.join(DATA_DIR, 'claude-prompt');
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
}

async function ensureWorkDir() {
  const dir = path.join(DATA_DIR, 'claude-prompt', 'work');
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function supervisorRequest(pathname, options = {}) {
  return fetch(`http://supervisor${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(10000),
  });
}

// Announce {host, port, token} to the Supervisor so the claude_ha integration
// auto-configures with zero user input. Re-sent on every boot (the Supervisor
// updates the existing message). Failure is non-fatal: the integration can
// still fall back to the `api_token` option.
async function announceDiscovery(token) {
  if (DEV || !process.env.SUPERVISOR_TOKEN) {
    log('discovery skipped (dev mode or no SUPERVISOR_TOKEN)');
    return;
  }
  const delays = [0, 5000, 15000, 30000];
  for (const delay of delays) {
    if (delay) await new Promise((r) => { setTimeout(r, delay); });
    try {
      const info = await supervisorRequest('/addons/self/info');
      if (!info.ok) throw new Error(`self/info HTTP ${info.status}`);
      // Supervisor JSON is untyped (Response.json() is `unknown`); read the one
      // field we need off an `any` view.
      const host = /** @type {any} */ (await info.json()).data?.hostname;
      if (!host) throw new Error('no hostname in self/info');
      const res = await supervisorRequest('/discovery', {
        method: 'POST',
        body: JSON.stringify({
          service: DISCOVERY_SERVICE,
          config: { host, port: PORT, token },
        }),
      });
      if (!res.ok) throw new Error(`discovery HTTP ${res.status}`);
      log(`discovery announced (${host}:${PORT})`);
      return;
    } catch (err) {
      log(`discovery attempt failed: ${err.message}`);
    }
  }
  log('discovery failed — the claude_ha integration can still use the api_token option');
}

// Start the prompt server. Returns a shutdown function; never throws in a way
// that should take the console down — the caller catches and logs.
async function start() {
  const options = readOptions();
  if (options.prompt_api === false) {
    log('disabled via prompt_api option');
    return () => {};
  }

  const token = await loadToken(options);
  // A dedicated restricted-user LLAT (prompt_ha_token) is preferred; the
  // general ha_token is the zero-extra-config fallback. Assist exposure still
  // caps what either can touch through the MCP server.
  const haToken = optionString(options, 'prompt_ha_token') || optionString(options, 'ha_token');

  // Ask the Supervisor where Core actually listens, then put a loopback relay in
  // front of it. Everything downstream — the spawned Claude's MCP client and the
  // camera-snapshot fetch — talks plain HTTP to the relay and never sees the HA
  // token or has to reason about Core's TLS. (ClaudeInHA#47)
  const coreTarget = await resolveCoreTarget();
  log(`core at ${coreTarget.origin} (${coreTarget.source})`);
  let relay = null;
  if (haToken) {
    const relayToken = crypto.randomBytes(32).toString('base64url');
    relay = await startCoreRelay({
      coreOrigin: coreTarget.origin, haToken, relayToken, log,
    });
    relay.token = relayToken;
    log(`core relay on 127.0.0.1:${relay.port}`);
  }

  const mcpConfigPath = relay
    ? await writeMcpConfig(HA_MCP_URL_OVERRIDE || `${relay.url}/api/mcp`, relay.token)
    : await writeMcpConfig('', '');
  const workDir = await ensureWorkDir();

  const redact = buildRedactor([
    token,
    haToken,
    optionString(options, 'ha_token'),
    optionString(options, 'api_key'),
    optionString(options, 'oauth_token'),
    process.env.SUPERVISOR_TOKEN,
    process.env.ANTHROPIC_API_KEY,
    process.env.CLAUDE_CODE_OAUTH_TOKEN,
  ]);

  const auditFile = path.join(DATA_DIR, 'claude-audit.log');
  const audit = (line) => {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    fs.appendFile(auditFile, `${ts}  ${line}\n`, () => {});
  };

  const app = createPromptApp({
    token,
    claudeBin: CLAUDE_BIN,
    usageBin: USAGE_BIN,
    mcpConfigPath,
    // A dedicated chat model (e.g. a faster/cheaper one) is preferred; fall back
    // to the console's model override, then the Claude default.
    model: optionString(options, 'chat_model') || optionString(options, 'model'),
    // Optional faster/cheaper model for spoken (voice) turns — replies are short
    // there, so latency matters more than raw capability. Empty → voice uses the
    // same `model` as text (no change).
    voiceModel: optionString(options, 'chat_model_voice'),
    dailyBudgetUsd: Number(options.chat_daily_budget_usd) || 0,
    // Camera snapshots (vision) go through the same relay, so the HA token and
    // the Core TLS decision live in exactly one place.
    coreRelayUrl: relay ? relay.url : '',
    coreRelayToken: relay ? relay.token : '',
    workDir,
    addonVersion: process.env.ADDON_VERSION || 'unknown',
    redact,
    audit,
    // Durable state (budget spend + chat-health window) lives alongside the MCP
    // config in the existing 0700 claude-prompt dir, so it survives restarts.
    stateDir: path.join(DATA_DIR, 'claude-prompt'),
    // The /data root, where the separate cc-alerts service writes alerts-state.json.
    // The server reads that file to publish the active-alerts set on /api/status.
    dataDir: DATA_DIR,
  });

  const server = http.createServer(app);
  await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve();
    });
  }));
  // Keep a persistent error handler so a post-bind socket error is logged, not
  // thrown as an uncaught exception that would take the shared console down.
  server.on('error', (err) => log(`server error: ${err.message}`));
  log(`prompt server listening on :${PORT} (ha_mcp: ${mcpConfigPath ? 'configured' : 'absent'})`);

  announceDiscovery(token).catch((err) => log(`discovery error: ${err.message}`));

  return function shutdown() {
    runner.shutdown();
    if (relay) relay.close();
    server.close();
    server.closeAllConnections();
  };
}

module.exports = { start };
