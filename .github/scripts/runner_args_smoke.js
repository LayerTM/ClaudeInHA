#!/usr/bin/env node
// Hands the prompt runs' real argument lists to a Claude Code binary and asserts
// that the binary accepts every one of them.
//
// Runs inside the built add-on image, so both sides are what ships: the run spec
// from the image's core, the command line from the image's Claude adapter, and
// the image's pinned CLI. The lists are never copied here, so a core, adapter or
// CLI change is checked against the others on the pull request that makes it.
//
// How acceptance is observed without an account or a network call: stdin is
// empty. The CLI parses and validates every option first (an unknown flag or a
// value outside an option's choices exits with its own message), and only then
// refuses to run with no prompt. So the one outcome that proves the whole list
// was accepted is that refusal, and anything else — including success — fails.
//
// Usage: node runner_args_smoke.js <claude binary> <console app dir> [addon-hooks.sh]
// (the hooks library defaults to the image's own copy)

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NO_INPUT = 'Input must be provided either through stdin or as a prompt argument';

const [bin, appDir, hooksLib = '/usr/local/lib/addon-hooks.sh'] = process.argv.slice(2);
if (!bin || !appDir) {
  console.error('usage: runner_args_smoke.js <claude binary> <console app dir>');
  process.exit(2);
}
const { launchSpec } = require(path.resolve(appDir, 'server/prompt/run.js'));
const { launch } = require(path.resolve(appDir, 'adapter/runner.js'));
const buildClaudeArgs = (options) => launch(launchSpec({ ...options, intents: options.intents || [] }), { env: {} }).args;
// The settings chat runs are given, built by the service script's own function.
const settings = spawnSync('bash', ['-c', 'source "$1" && hooks_audit_settings_json', 'bash', hooksLib], { encoding: 'utf8' });
if (settings.status !== 0 || !settings.stdout.trim()) {
  console.error(`could not build the chat settings from ${hooksLib}: ${settings.stderr || settings.error}`);
  process.exit(2);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'args-smoke-'));
const mcpConfigPath = path.join(home, 'ha-mcp.json');
fs.writeFileSync(mcpConfigPath, JSON.stringify({
  mcpServers: { ha: { type: 'http', url: 'http://127.0.0.1:9/api/mcp', headers: { Authorization: 'Bearer x' } } },
}));

// Every branch of the builder at least once: both modes, with and without the
// MCP server, vision, a model, streaming, and each read-side directive.
const cases = {
  'read, no MCP server': { mode: 'read' },
  'read, everything on': {
    mode: 'read',
    mcpConfigPath,
    imagePath: path.join(home, 'snap.jpg'),
    model: 'sonnet',
    language: 'uk',
    surface: 'voice',
    editAutomation: { alias: 'a', triggers: [], actions: [] },
    // a catalog with a tool this read may not call, so the hidden-tools list is exercised
    haTools: ['mcp__ha__homeassistant__GetLiveContext', 'mcp__ha__intent__HassTurnOn'],
    stream: true,
    settings: settings.stdout.trim(),
  },
  'write, MCP server and model': {
    mode: 'write',
    mcpConfigPath,
    model: 'sonnet',
    settings: settings.stdout.trim(),
    intents: [
      { intent: 'HassTurnOn', targets: ['light.a'], risk: 'low' },
      { intent: 'HassTurnOff', targets: ['light.b'], risk: 'low' },
    ],
  },
  'write, no MCP server': {
    mode: 'write',
    intents: [{ intent: 'HassTurnOn', targets: ['light.a'], risk: 'low' }],
  },
};

let failed = 0;
for (const [label, options] of Object.entries(cases)) {
  const args = buildClaudeArgs(options);
  const run = spawnSync(bin, args, {
    input: '',
    encoding: 'utf8',
    timeout: 60000,
    env: { PATH: process.env.PATH, HOME: home, TERM: 'dumb', IS_SANDBOX: '1', DISABLE_AUTOUPDATER: '1' },
  });
  const output = `${run.stderr || ''}${run.stdout || ''}`.trim();
  if (run.status !== 0 && output.includes(NO_INPUT)) {
    console.log(`ok     - ${label}`);
  } else {
    failed += 1;
    console.log(`NOT ok - ${label}: exit ${run.status}${run.error ? ` (${run.error.message})` : ''}`);
    console.log(`         ${output.split('\n').slice(0, 5).join('\n         ')}`);
    console.log(`         flags: ${args.filter((a) => a.startsWith('--')).join(' ')}`);
  }
}
fs.rmSync(home, { recursive: true, force: true });
if (failed) {
  console.log(`${failed} argument list(s) rejected by ${bin}`);
  process.exit(1);
}
console.log(`every argument list accepted by ${bin}`);
