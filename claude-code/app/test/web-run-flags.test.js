'use strict';

// What a web grant from the core becomes on the Claude command line: exactly the
// web tools the grant names, an allowlist per listed domain, and nothing of the
// home (no MCP config, no Home Assistant tool).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildClaudeArgs } = require('./fixtures/claude-run');
const adapter = require('../adapter');

const flag = (args, name) => args[args.indexOf(name) + 1];
const web = (over) => ({ search: true, fetch: false, domains: [], ...over });
const argsFor = (grant) => buildClaudeArgs({ web: grant, mcpConfigPath: '/tmp/ha-mcp.json' });

test('the adapter declares search and fetch to the core', () => {
  assert.deepEqual(adapter.runner.webCapability, { search: true, fetch: true });
});

test('search alone: WebSearch is the only tool and the only allowance', () => {
  const args = argsFor(web());
  assert.equal(flag(args, '--tools'), 'WebSearch');
  assert.equal(flag(args, '--allowed-tools'), 'WebSearch');
});

test('search and fetch: WebFetch is allowed per listed domain only', () => {
  const args = argsFor(web({ fetch: true, domains: ['example.com', 'docs.example.org'] }));
  assert.equal(flag(args, '--tools'), 'WebSearch,WebFetch');
  assert.equal(
    flag(args, '--allowed-tools'),
    'WebSearch,WebFetch(domain:example.com),WebFetch(domain:docs.example.org)',
  );
});

test('a web run carries no MCP config, Home Assistant tool or Read', () => {
  for (const grant of [web(), web({ fetch: true, domains: ['example.com'] })]) {
    const args = argsFor(grant);
    assert.ok(!args.includes('--mcp-config'));
    assert.ok(!args.some((a) => a.includes('mcp__')));
    assert.ok(!args.includes('--disallowed-tools'));
    assert.ok(args.includes('--strict-mcp-config'));
    assert.ok(!flag(args, '--tools').split(',').includes('Read'));
  }
});

test('a run without a web grant offers no web tool', () => {
  const args = buildClaudeArgs({ mcpConfigPath: '/tmp/ha-mcp.json' });
  assert.ok(!args.join(' ').includes('Web'));
});

test('{fetch, no domains}: WebSearch is the only tool and WebFetch is not offered', () => {
  const args = argsFor(web({ fetch: true, domains: [] }));
  assert.equal(flag(args, '--tools'), 'WebSearch');
  assert.equal(flag(args, '--allowed-tools'), 'WebSearch');
  assert.ok(!args.includes('--settings'));
});

test('a fetch-only grant offers WebFetch and no search', () => {
  const args = argsFor(web({ search: false, fetch: true, domains: ['example.com'] }));
  assert.equal(flag(args, '--tools'), 'WebFetch');
  assert.equal(flag(args, '--allowed-tools'), 'WebFetch(domain:example.com)');
});

test('search alone carries no settings', () => {
  assert.ok(!argsFor(web()).includes('--settings'));
});

const settingsOf = (args) => JSON.parse(flag(args, '--settings'));

test('a fetch grant carries a WebFetch PreToolUse guard naming exactly the listed domains', () => {
  const s = settingsOf(argsFor(web({ fetch: true, domains: ['example.com', 'docs.example.org'] })));
  assert.equal(s.hooks.PreToolUse.length, 1);
  assert.equal(s.hooks.PreToolUse[0].matcher, 'WebFetch');
  const { command } = s.hooks.PreToolUse[0].hooks[0];
  assert.ok(command.endsWith(' example.com docs.example.org'), command);
  assert.ok(command.includes('web-fetch-guard.js'));
});

test('the guard is added next to the settings the core passes', () => {
  const given = JSON.stringify({ hooks: { PostToolUse: [{ matcher: '*', hooks: [] }] } });
  const args = require('../adapter').runner.launch(
    require('../server/prompt/run').launchSpec({ web: web({ fetch: true, domains: ['example.com'] }), settings: given, intents: [] }),
    { env: {} },
  ).args;
  const s = settingsOf(args);
  assert.ok(s.hooks.PostToolUse && s.hooks.PreToolUse);
});

test('the guard allows a listed host and denies preapproved docs hosts and subdomains', () => {
  const { verdict } = require('../adapter/web-host-policy');
  const call = (url) => verdict({ tool_input: { url } }, ['example.com']);
  assert.equal(call('https://example.com/a?b=1'), null);
  assert.equal(call('https://EXAMPLE.com./a'), null);
  assert.equal(call('https://example.com:8443/a'), null);
  assert.match(call('https://docs.python.org/3/'), /not a site/);
  assert.match(call('https://www.example.com/'), /not a site/);
  assert.match(call('https://example.com.evil.net/'), /not a site/);
  assert.match(call('https://example.com@evil.net/'), /not a site/);
  assert.match(call('not a url'), /valid URL/);
  assert.match(verdict(null, ['example.com']), /valid URL/);
});

test('the guard script exits 2 with a reason for docs.python.org, garbage and no input, and 0 for a listed host', () => {
  const { spawnSync } = require('node:child_process');
  const script = require.resolve('../adapter/web-fetch-guard');
  const run = (input) => spawnSync(process.execPath, [script, 'example.com'], { input, encoding: 'utf8' });
  const ok = run(JSON.stringify({ tool_input: { url: 'https://example.com/' } }));
  assert.equal(ok.status, 0);
  assert.equal(ok.stderr, '');
  for (const input of [JSON.stringify({ tool_input: { url: 'https://docs.python.org/3/' } }), 'garbage', '', '{}']) {
    const denied = run(input);
    assert.equal(denied.status, 2, input);
    assert.ok(denied.stderr.length > 0, input);
  }
});

test('the hook runs the node binary of this process by absolute path', () => {
  const s = settingsOf(argsFor(web({ fetch: true, domains: ['example.com'] })));
  assert.ok(s.hooks.PreToolUse[0].hooks[0].command.startsWith(`'${process.execPath}' `));
});
