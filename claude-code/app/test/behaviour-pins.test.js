'use strict';

// Behaviour pins: the exact things the add-on hands to the Claude CLI and to the
// companion integration, stated in full rather than piece by piece. The other
// suites assert what each flag or field MEANS; these assert that nothing else
// changed, so moving code between modules can be checked against them.
//
// runner-args.golden.json is regenerated only on purpose:
//   UPDATE_GOLDEN=1 node --test test/behaviour-pins.test.js
// and the diff it produces is the change to review.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runner = require('./fixtures/claude-run');
const { createPromptApp } = require('../server/prompt/server');
const cases = require('./fixtures/runner-args-cases');

const GOLDEN = path.join(__dirname, 'fixtures', 'runner-args.golden.json');
const STUB = path.join(__dirname, 'fixtures', 'claude-stub.js');

// The stub runs through its own interpreter path, so the environment under test
// needs no `node` on PATH (the runner hands the child a PATH of its choosing).
function stubWithAbsoluteNode(dir) {
  const wrapper = path.join(dir, 'claude-stub-wrapper.js');
  fs.writeFileSync(wrapper, `#!${process.execPath}\nrequire(${JSON.stringify(STUB)});\n`, { mode: 0o755 });
  return wrapper;
}

// What the stub saw, minus what the OS itself adds to every process (macOS sets
// __CF_USER_TEXT_ENCODING when a developer runs this suite locally).
function readDumpedEnv(work) {
  const env = JSON.parse(fs.readFileSync(path.join(work, 'stub-env.json'), 'utf8'));
  fs.rmSync(work, { recursive: true, force: true });
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('__CF_')));
}

function argsFor(c) {
  return runner.buildClaudeArgs({ ...c, intents: c.intents || [] });
}

if (process.env.UPDATE_GOLDEN === '1') {
  const out = Object.fromEntries(Object.entries(cases).map(([name, c]) => [name, argsFor(c)]));
  fs.writeFileSync(GOLDEN, `${JSON.stringify(out, null, 2)}\n`);
}

test('the argument list of every kind of run is exactly the recorded one', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.deepEqual(Object.keys(golden).sort(), Object.keys(cases).sort(), 'every case has a recording');
  for (const [name, c] of Object.entries(cases)) {
    assert.deepEqual(argsFor(c), golden[name], name);
  }
});

test('the CLI gets exactly the allowlisted environment, and no credential of Home Assistant', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pins-env-'));
  const saved = { ...process.env };
  const parent = {
    PATH: '/usr/bin:/bin',
    HOME: '/data/home',
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    USER: 'root',
    LOGNAME: 'root',
    ANTHROPIC_API_KEY: 'sk-ant-api03-EXAMPLEpins000000000',
    CLAUDE_CODE_OAUTH_TOKEN: 'EXAMPLE-oauth-pins',
    HTTP_PROXY: 'http://proxy.example:3128',
    HTTPS_PROXY: 'http://proxy.example:3128',
    NO_PROXY: 'localhost',
    http_proxy: 'http://proxy.example:3128',
    https_proxy: 'http://proxy.example:3128',
    no_proxy: 'localhost',
    SUPERVISOR_TOKEN: 'EXAMPLE-supervisor',
    SUPERVISOR_API_TOKEN: 'EXAMPLE-supervisor',
    HA_TOKEN: 'EXAMPLE-ha',
    HASS_TOKEN: 'EXAMPLE-ha',
    HASS_SERVER: 'http://homeassistant:8123',
    HA_URL: 'http://homeassistant:8123',
    HA_NOTIFY_SERVICE: 'notify.phone',
    CUSTOM_USER_VAR: 'from-environment_vars',
    ANTHROPIC_MODEL: 'console-model',
  };
  try {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, parent);
    const outcome = await runner.runClaude({
      bin: stubWithAbsoluteNode(work), prompt: 'ENVDUMP hello', mode: 'read', intents: [], cwd: work,
    });
    assert.equal(outcome.status, 'ok');
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  const env = readDumpedEnv(work);
  assert.deepEqual(env, {
    PATH: '/usr/bin:/bin',
    HOME: '/data/home',
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    IS_SANDBOX: '1',
    DISABLE_AUTOUPDATER: '1',
    ANTHROPIC_API_KEY: 'sk-ant-api03-EXAMPLEpins000000000',
    CLAUDE_CODE_OAUTH_TOKEN: 'EXAMPLE-oauth-pins',
    HTTP_PROXY: 'http://proxy.example:3128',
    HTTPS_PROXY: 'http://proxy.example:3128',
    NO_PROXY: 'localhost',
    http_proxy: 'http://proxy.example:3128',
    https_proxy: 'http://proxy.example:3128',
    no_proxy: 'localhost',
    USER: 'root',
    LOGNAME: 'root',
  });
});

test('the CLI environment falls back to fixed defaults when the parent has none', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pins-env-'));
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) delete process.env[k];
    const outcome = await runner.runClaude({
      bin: stubWithAbsoluteNode(work), prompt: 'ENVDUMP hello', mode: 'read', intents: [], cwd: work,
    });
    assert.equal(outcome.status, 'ok');
  } finally {
    Object.assign(process.env, saved);
  }
  const env = readDumpedEnv(work);
  assert.deepEqual(env, {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/data/home',
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    IS_SANDBOX: '1',
    DISABLE_AUTOUPDATER: '1',
  });
});

test('/api/status answers with exactly the recorded set of fields', async () => {
  const token = 'behaviour-pins-token-0000000000000000';
  const app = createPromptApp({
    token,
    claudeBin: STUB,
    usageBin: '/bin/true',
    mcpConfigPath: '',
    model: 'm',
    workDir: os.tmpdir(),
    addonVersion: 'pins',
    redact: (x) => x,
    audit: () => {},
    proactiveAlerts: false,
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), [
      'alerts', 'body_max_bytes', 'budget', 'chat_health', 'claude_version', 'engine', 'engine_version', 'ha_mcp',
      'ha_mcp_connected', 'model', 'prompt_max_bytes', 'prompt_timeout_ms', 'ready', 'request_fields', 'version',
    ]);
    assert.deepEqual(Object.keys(body.budget).sort(), ['limit', 'spent']);
    assert.deepEqual(body, {
      ...body,
      version: 'pins',
      claude_version: '9.9.9',
      engine: 'claude',
      engine_version: '9.9.9',
      request_fields: [
        'prompt', 'mode', 'conversation_id', 'intents', 'confirmation', 'image_entity', 'stream', 'language',
        'surface', 'edit_automation',
      ],
      model: 'm',
      prompt_max_bytes: 8 * 1024,
      body_max_bytes: 64 * 1024,
      ha_mcp: false,
      ha_mcp_connected: false,
      prompt_timeout_ms: runner.TIMEOUT_MS,
      budget: { limit: 0, spent: 0 },
      alerts: null,
    });
    assert.equal(typeof body.ready, 'boolean');
    assert.equal(typeof body.chat_health, 'object');
  } finally {
    server.close();
  }
});

test('the adapter names the engine and reads the version from `claude --version`', () => {
  const { descriptor } = require('../adapter');
  assert.equal(descriptor.engine, 'claude');
  assert.equal(descriptor.versionAlias, 'claude_version');
  assert.equal(descriptor.parseVersion('2.1.274 (Claude Code)'), '2.1.274');
  assert.equal(descriptor.parseVersion('9.9.9'), '9.9.9');
  assert.equal(descriptor.parseVersion(''), null);
});
