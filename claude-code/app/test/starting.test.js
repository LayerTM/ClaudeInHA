'use strict';

// The startup placeholder's whole job is to answer while nothing else can, and
// then to get out of the way. Both halves are asserted here: what it says while
// it holds the ingress port, and that the port is actually free the moment it
// is asked to stop — a placeholder that lingers would turn a blank panel into a
// console that never starts, which is worse than the problem it solves.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { sourceAllowed } = require('../server/sources');

const SCRIPT = path.join(__dirname, '..', 'server', 'starting.js');
const RUN_SCRIPT = path.join(
  __dirname, '..', '..', 'rootfs', 'etc', 's6-overlay', 's6-rc.d', 'claude-code', 'run',
);

async function freePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = /** @type {net.AddressInfo} */ (probe.address());
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
  });
}

async function startPlaceholder(port) {
  const child = spawn(process.execPath, [SCRIPT], {
    env: { ...process.env, CLAUDE_CONSOLE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('placeholder never reported listening')), 10000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(undefined); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`exited early (${code})`)); });
  });
  return child;
}

test('answers the panel while the add-on is still initializing', async () => {
  const port = await freePort();
  const child = await startPlaceholder(port);
  try {
    const page = await get(port, '/');
    assert.equal(page.status, 200);
    assert.match(page.body, /Starting the console/);
    assert.equal(page.headers['cache-control'], 'no-store');

    // HA ingress can ask with a doubled leading slash; that must not 404 into
    // an unexplained blank, which is the failure this page exists to replace.
    const doubled = await get(port, '//index.html');
    assert.equal(doubled.status, 200);
    assert.match(doubled.body, /Starting the console/);

    // The one signal both the fresh page and an already-open panel read.
    const health = await get(port, '/api/health');
    assert.equal(health.status, 503);
    assert.deepEqual(JSON.parse(health.body), { ok: false, starting: true });
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
});

test('refuses a websocket instead of leaving the client hanging', async () => {
  const port = await freePort();
  const child = await startPlaceholder(port);
  try {
    const socket = net.connect(port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(
      'GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n'
      + 'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n'
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
    );
    let received = '';
    socket.on('data', (c) => { received += c; });
    await once(socket, 'close');
    assert.doesNotMatch(received, /101/, 'must not accept the upgrade');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
});

test('releases the port the moment it is stopped', async () => {
  const port = await freePort();
  const child = await startPlaceholder(port);
  child.kill('SIGTERM');
  await once(child, 'exit');

  // What the console does next, in the same order the run script does it.
  const server = http.createServer((req, res) => res.end('console'));
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const answer = await get(port, '/');
  assert.equal(answer.body, 'console');
  await new Promise((resolve) => server.close(resolve));
});

test('the source guard is the same one the console uses', () => {
  assert.equal(sourceAllowed({ remoteAddress: '172.30.32.2' }, false), true, 'ingress gateway');
  assert.equal(sourceAllowed({ remoteAddress: '127.0.0.1' }, false), true, 'loopback');
  assert.equal(sourceAllowed({ remoteAddress: '192.0.2.9' }, false), false, 'anything else');
  assert.equal(sourceAllowed({}, false), false, 'no address at all');
  assert.equal(sourceAllowed({ remoteAddress: '192.0.2.9' }, true), true, 'dev mode');
});

test('the run script holds the port for the whole of initialization', () => {
  const run = fs.readFileSync(RUN_SCRIPT, 'utf8');
  const started = run.indexOf('server/starting.js');
  const firstInitStep = run.indexOf('mkdir -p /data/home');
  const stopped = run.lastIndexOf('kill "${starting_pid}"');
  const consoleExec = run.indexOf('exec node /opt/claude-console/server/index.js');

  assert.ok(started > -1, 'the placeholder is started');
  assert.ok(consoleExec > -1, 'the console is exec\'d');
  assert.ok(
    started < firstInitStep,
    'the placeholder must start before initialization, or the panel is blank for exactly the time it takes',
  );
  assert.ok(
    stopped > -1 && stopped < consoleExec,
    'the placeholder must be stopped before the console binds the same port',
  );
  assert.match(run, /wait "\$\{starting_pid\}"/, 'and waited for, so the handover cannot race');
});
