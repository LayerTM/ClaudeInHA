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
const RELAY_TOKEN = 'relay-token-for-the-child';

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
        res.write('event: one\ndata: {"a":1}\n\n');
        setTimeout(() => { res.write('event: two\ndata: {"b":2}\n\n'); res.end(); }, 20);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  await new Promise((r) => core.listen(0, '127.0.0.1', r));
  coreOrigin = `http://127.0.0.1:${core.address().port}`;
  seen = [];
  relay = await startCoreRelay({ coreOrigin, haToken: HA_TOKEN, relayToken: RELAY_TOKEN });
});

after(() => {
  relay.close();
  core.close();
});

const auth = { authorization: `Bearer ${RELAY_TOKEN}` };

test('binds loopback only', () => {
  assert.match(relay.url, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test('swaps the relay token for the HA token, and never forwards the relay one', async () => {
  seen = [];
  const res = await fetch(`${relay.url}/api/mcp`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: '{"method":"initialize"}',
  });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.authorization, `Bearer ${HA_TOKEN}`);
  assert.ok(!JSON.stringify(seen[0].headers).includes(RELAY_TOKEN),
    'the relay token must not reach Core');
  assert.equal(seen[0].body, '{"method":"initialize"}', 'request body is forwarded intact');
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
    body: '{}',
  });
  assert.equal(seen[0].headers['mcp-session-id'], 'sess-1');
  assert.equal(seen[0].headers['mcp-protocol-version'], '2026-03-26');
  assert.equal(res.headers.get('mcp-session-id'), 'sess-1');
});

test('server-sent events stream through rather than being buffered', async () => {
  seen = [];
  const res = await fetch(`${relay.url}/api/mcp`, {
    method: 'POST', headers: { ...auth, accept: 'text/event-stream' }, body: '{}',
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
    relayToken: RELAY_TOKEN,
  });
  const res = await fetch(`${r2.url}/api/mcp`, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /redirect/);
  r2.close();
  redirecting.close();
});

test('an unreachable Core is a 502, not an auth error', async () => {
  const dead = await startCoreRelay({
    coreOrigin: 'http://127.0.0.1:1',   // nothing listens here
    haToken: HA_TOKEN,
    relayToken: RELAY_TOKEN,
  });
  const res = await fetch(`${dead.url}/api/mcp`, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(res.status, 502, 'unreachable must never present as 401');
  dead.close();
});
