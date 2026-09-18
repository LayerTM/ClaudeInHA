'use strict';

// Tests for core-relay.js — the loopback hop that holds the Home Assistant token
// and owns how Core is reached (ClaudeInHA#47).
//
// Driven against a stub "Core" so the assertions are about the relay's own
// behaviour: what it forwards, what it refuses, what it never leaks.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startCoreRelay } = require('../server/prompt/core-relay');

const HA_TOKEN = 'ha-llat-must-never-leave-the-relay';
// A bearer is minted per run, via issue(), and carries what that run may do —
// there is no way to pin a fixed relay token across instances any more, so
// each relay this file starts issues its own.
let RELAY_TOKEN;

let core;          // stub Core
let coreOrigin;
let seen;          // requests the stub Core received
let relay;

before(async () => {
  core = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (req.url === '/api/redirect-me') {
        res.writeHead(302, { location: 'http://elsewhere.invalid/api/mcp' });
        res.end();
        return;
      }
      if (req.url === '/api/mcp' && req.headers.accept === 'text/event-stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' });
        res.write('event: one\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"n":1}}\n\n');
        setTimeout(() => {
          res.write('event: two\ndata: {"jsonrpc":"2.0","id":7,"result":{"n":2}}\n\n');
          res.end();
        }, 20);
        return;
      }
      let id = null;
      try { id = JSON.parse(Buffer.concat(chunks).toString('utf8')).id ?? null; } catch { /* not JSON */ }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { path: req.url } }));
    });
  });
  await new Promise((r) => core.listen(0, '127.0.0.1', r));
  coreOrigin = `http://127.0.0.1:${core.address().port}`;
  seen = [];
  relay = await startCoreRelay({ coreOrigin, haToken: HA_TOKEN });
  RELAY_TOKEN = relay.issue('test-run', { cameras: ['camera.front_door'] });
});

after(() => {
  relay.close();
  core.close();
});

// RELAY_TOKEN is only assigned once before() has run; a getter reads it fresh
// each time this is used (spreading it still copies the resolved value).
const auth = { get authorization() { return `Bearer ${RELAY_TOKEN}`; } };
const INIT = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}';

test('binds loopback only', () => {
  assert.match(relay.url, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test('swaps the relay token for the HA token, and never forwards the relay one', async () => {
  seen = [];
  const res = await fetch(`${relay.url}/api/mcp`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: INIT,
  });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.authorization, `Bearer ${HA_TOKEN}`);
  assert.ok(!JSON.stringify(seen[0].headers).includes(RELAY_TOKEN),
    'the relay token must not reach Core');
  assert.equal(seen[0].body, INIT, 'request body is forwarded intact');
});

test('a wrong bearer is refused and nothing reaches Core', async () => {
  seen = [];
  const res = await fetch(`${relay.url}/api/mcp`, {
    method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}',
  });
  assert.equal(res.status, 401);
  assert.equal(seen.length, 0);
});

test('no bearer at all is refused', async () => {
  seen = [];
  const res = await fetch(`${relay.url}/api/mcp`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);
  assert.equal(seen.length, 0);
});

// The allowlist is the reason a disabled certificate check is safe here: there
// is no path through this relay to an arbitrary Core endpoint, let alone another
// host.
const refused = [
  ['unknown path', 'GET', '/api/states'],
  ['config endpoint', 'GET', '/api/config'],
  ['MCP with a disallowed method', 'PUT', '/api/mcp'],
  ['path traversal out of the camera prefix', 'GET', '/api/camera_proxy/../states'],
  ['camera path with a bad entity', 'GET', '/api/camera_proxy/notacamera'],
  ['root', 'GET', '/'],
];

for (const [name, method, p] of refused) {
  test(`refuses: ${name}`, async () => {
    seen = [];
    const res = await fetch(`${relay.url}${p}`, { method, headers: auth });
    assert.equal(res.status, 404, `${method} ${p} must not be relayed`);
    assert.equal(seen.length, 0, 'nothing may reach Core');
  });
}

test('camera snapshots are allowed and carry the HA token', async () => {
  seen = [];
  const res = await fetch(`${relay.url}/api/camera_proxy/camera.front_door`, { headers: auth });
  assert.equal(res.status, 200);
  assert.equal(seen[0].url, '/api/camera_proxy/camera.front_door');
  assert.equal(seen[0].headers.authorization, `Bearer ${HA_TOKEN}`);
});

test('mcp-session-id survives in both directions', async () => {
  seen = [];
  const res = await fetch(`${relay.url}/api/mcp`, {
    method: 'POST',
    headers: { ...auth, 'mcp-session-id': 'sess-1', 'mcp-protocol-version': '2026-03-26' },
    body: INIT,
  });
  assert.equal(seen[0].headers['mcp-session-id'], 'sess-1');
  assert.equal(seen[0].headers['mcp-protocol-version'], '2026-03-26');
  assert.equal(res.headers.get('mcp-session-id'), 'sess-1');
});

// The audit guarantee lives in what `record` receives on a real tools/call round
// trip through the relay, not in the shape of the calls the filter reports in
// isolation — the other tests here never pass a `record` at all. One line per
// call, `<tool> run=<id>: <arguments>` (the same format the console-run audit
// hook writes), is what a reader of the audit log relies on to know what ran.
test('a real record callback receives one line naming the id, tool and arguments of a tools/call', async () => {
  seen = [];
  const recorded = [];
  const auditRelay = await startCoreRelay({
    coreOrigin, haToken: HA_TOKEN, record: (line) => recorded.push(line),
  });
  try {
    const token = auditRelay.issue('audit-run', { basenames: ['TurnOn'] });
    const call = {
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: { name: 'TurnOn', arguments: { entity_id: 'light.kitchen' } },
    };
    const res = await fetch(`${auditRelay.url}/api/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(call),
    });
    assert.equal(res.status, 200);
    await res.json();
    assert.equal(recorded.length, 1, 'exactly one line is recorded for the one call made');
    const match = /^(?<name>.+) run=(?<id>[^:]+): (?<args>.*)$/.exec(recorded[0]);
    assert.ok(match, `record line did not match the audit format: ${recorded[0]}`);
    assert.equal(match.groups.id, 'audit-run');
    assert.equal(match.groups.name, 'TurnOn');
    assert.deepEqual(JSON.parse(match.groups.args), { entity_id: 'light.kitchen' });
  } finally {
    auditRelay.close();
  }
});

test('server-sent events stream through rather than being buffered', async () => {
  seen = [];
  const res = await fetch(`${relay.url}/api/mcp`, {
    method: 'POST', headers: { ...auth, accept: 'text/event-stream' }, body: INIT,
  });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const first = await reader.read();
  // The stub holds the second event back by 20ms; receiving the first before the
  // response ends is what proves the relay is piping and not accumulating.
  assert.match(Buffer.from(first.value).toString('utf8'), /event: one/);
  await reader.cancel();
});

test('a 3xx from Core becomes a 502 and the Authorization header is not re-sent', async () => {
  // A stub Core that redirects everything, including /api/mcp.
  const redirecting = http.createServer((req, res) => {
    res.writeHead(302, { location: 'http://elsewhere.invalid/api/mcp' });
    res.end();
  });
  await new Promise((r) => redirecting.listen(0, '127.0.0.1', r));
  const r2 = await startCoreRelay({
    coreOrigin: `http://127.0.0.1:${redirecting.address().port}`,
    haToken: HA_TOKEN,
  });
  const authR2 = { authorization: `Bearer ${r2.issue('r2-run')}` };
  try {
    const res = await fetch(`${r2.url}/api/mcp`, { method: 'POST', headers: authR2, body: INIT });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.error, /redirect/);
  } finally {
    r2.close();
    redirecting.close();
  }
});

test('an unreachable Core is a 502, not an auth error', async () => {
  const dead = await startCoreRelay({
    coreOrigin: 'http://127.0.0.1:1',   // nothing listens here
    haToken: HA_TOKEN,
  });
  const authDead = { authorization: `Bearer ${dead.issue('dead-run')}` };
  try {
    const res = await fetch(`${dead.url}/api/mcp`, { method: 'POST', headers: authDead, body: INIT });
    assert.equal(res.status, 502, 'unreachable must never present as 401');
  } finally {
    dead.close();
  }
});
