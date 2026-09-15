#!/usr/bin/env node
// Hands the prompt runner's real argument lists to a Claude Code binary and
// asserts that the binary accepts every one of them.
//
// Runs inside the built add-on image, so both sides are what ships: the argument
// builder from the image's console app and the image's pinned CLI. The lists are
// never copied here — they come from buildClaudeArgs — so a runner change and a
// CLI bump are checked against each other on the pull request that makes either.
//
// How acceptance is observed without an account or a network call: stdin is
// empty. The CLI parses and validates every option first (an unknown flag or a
// value outside an option's choices exits with its own message), and only then
// refuses to run with no prompt. So the one outcome that proves the whole list
// was accepted is that refusal, and anything else — including success — fails.
//
// Usage: node runner_args_smoke.js <claude binary> <runner.js>

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NO_INPUT = 'Input must be provided either through stdin or as a prompt argument';

const [bin, runnerPath] = process.argv.slice(2);
if (!bin || !runnerPath) {
  console.error('usage: runner_args_smoke.js <claude binary> <runner.js>');
  process.exit(2);
}
const { buildClaudeArgs } = require(path.resolve(runnerPath));

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
    haTools: ['mcp__ha__homeassistant__GetLiveContext'],
    stream: true,
  },
  'write, MCP server and model': {
    mode: 'write',
    mcpConfigPath,
    model: 'sonnet',
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
