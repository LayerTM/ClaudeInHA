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
