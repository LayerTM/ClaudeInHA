'use strict';

// Which JSON-RPC messages pass between an agent and Home Assistant's MCP server:
// the decisions themselves, and the relay applying them to real HTTP traffic.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  MAX_BODY_BYTES, judgeClientBody, filterServerJson, createSseFilter,
} = require('../server/prompt/mcp-filter');
const { startCoreRelay } = require('../server/prompt/core-relay');

const rpc = (method, id, params) => ({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) });
const judge = (value) => judgeClientBody(typeof value === 'string' ? value : JSON.stringify(value));

// --- agent → server -------------------------------------------------------------

test('the methods a prompt run needs are forwarded', () => {
  for (const m of [rpc('initialize', 0, {}), rpc('ping', 1), rpc('tools/list', 2), rpc('tools/call', 3, { name: 'x' }),
    rpc('notifications/initialized'), rpc('notifications/cancelled', undefined, { requestId: 3 })]) {
    assert.deepEqual(judge(m), { forward: true }, m.method);
  }
  assert.deepEqual(judge([rpc('tools/list', 1), rpc('notifications/initialized')]), { forward: true });
});

test('every other method is answered "method not found" and not forwarded', () => {
  for (const method of ['resources/list', 'resources/read', 'resources/templates/list', 'resources/subscribe',
    'prompts/list', 'prompts/get', 'completion/complete', 'logging/setLevel', 'server/discover', 'tools/delete', 'x']) {
    const verdict = judge(rpc(method, 'id-1'));
    assert.equal(verdict.forward, false, method);
    assert.equal(verdict.status, 200, method);
    assert.deepEqual(JSON.parse(verdict.body), { jsonrpc: '2.0', id: 'id-1', error: { code: -32601, message: 'Method not found' } });
  }
  // A refused message that asks no answer gets none.
  assert.deepEqual(judge(rpc('resources/updated')), { forward: false, status: 202, body: '' });
  // The agent may answer no server request, because none are let through.
  assert.deepEqual(judge({ jsonrpc: '2.0', id: 4, result: { roots: [] } }), { forward: false, status: 202, body: '' });
});

test('a batch with any refused message is not forwarded, and each request in it is answered', () => {
  const verdict = judge([rpc('tools/list', 1), rpc('resources/read', 2, { uri: 'x' }), rpc('notifications/initialized')]);
  assert.equal(verdict.forward, false);
  assert.deepEqual(JSON.parse(verdict.body), [
    { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Sent together with a method that is not allowed' } },
    { jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'Method not found' } },
  ]);
});

test('a body that is not JSON-RPC 2.0 is refused as a bad request', () => {
  for (const body of ['not json', '[]', '5', '"initialize"', '{"method":"initialize","id":1}',
    '{"jsonrpc":"1.0","method":"ping","id":1}', '[1]', 'null']) {
    const verdict = judge(body);
    assert.equal(verdict.forward, false, body);
    assert.equal(verdict.status, 400, body);
  }
});

// --- server → agent ---------------------------------------------------------------

test('from the server only responses and notifications reach the agent', () => {
  const response = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} });
  const failure = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 1, message: 'x' } });
  const note = JSON.stringify(rpc('notifications/progress', undefined, { p: 1 }));
  assert.equal(filterServerJson(response), response);
  assert.equal(filterServerJson(failure), failure);
  assert.equal(filterServerJson(note), note);
  for (const dropped of [rpc('sampling/createMessage', 9, {}), rpc('elicitation/create', 9), rpc('roots/list', 9),
    rpc('notifications/progress', 9), rpc('ping', 9), { jsonrpc: '2.0', id: 1 }, { id: 1, result: {} }]) {
    assert.equal(filterServerJson(JSON.stringify(dropped)), '', JSON.stringify(dropped));
  }
  assert.equal(filterServerJson('not json'), '');
  assert.equal(filterServerJson(JSON.stringify([rpc('roots/list', 9), JSON.parse(response)])), `[${response}]`);
  assert.equal(filterServerJson(JSON.stringify([rpc('roots/list', 9)])), '');
});

test('server-sent events are filtered one event at a time, however they are split', () => {
  const written = [];
  const sse = createSseFilter((chunk) => written.push(chunk));
  sse.push(': keep-alive\n\nevent: message\ndata: {"jsonrpc":"2.0","id":1,');
  assert.deepEqual(written, [': keep-alive\n\n'], 'a comment passes at once; half an event waits');
  sse.push('"result":{}}\n\nevent: message\r\ndata: {"jsonrpc":"2.0","id":2,"method":"sampling/createMessage"}\r\n\r\n');
  sse.push('data: not json\n\nretry: 100\n\ndata: {"jsonrpc":"2.0",\ndata: "method":"notifications/message"}\n\n');
  sse.push('data: {"jsonrpc":"2.0","id":3,"result":{}}');
  sse.end();
  assert.deepEqual(written, [
    ': keep-alive\n\n',
    'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n',
    'retry: 100\n\n',
    'data: {"jsonrpc":"2.0",\ndata: "method":"notifications/message"}\n\n',
    'data: {"jsonrpc":"2.0","id":3,"result":{}}\n\n',
  ]);
});

// --- through the relay -------------------------------------------------------------

const TOKEN = 'relay-token-filter';
let core;
let relay;
let seen;
let reply; // (req, res, body) => void, set per test

before(async () => {
  core = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, body });
      reply(req, res, body);
    });
  });
  await new Promise((r) => core.listen(0, '127.0.0.1', r));
  relay = await startCoreRelay({ coreOrigin: `http://127.0.0.1:${core.address().port}`, haToken: 'ha', relayToken: TOKEN });
});

after(() => {
  relay.close();
  core.close();
});

beforeEach(() => {
  seen = [];
  reply = (req, res, body) => {
    let id = null;
    try { id = JSON.parse(body).id ?? null; } catch { /* not JSON */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }));
  };
});

const post = (body, headers = {}) => fetch(`${relay.url}/api/mcp`, {
  method: 'POST',
  headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('a refused method never reaches Home Assistant', async () => {
  const res = await post(rpc('resources/read', 5, { uri: 'homeassistant://assist/context-snapshot' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { jsonrpc: '2.0', id: 5, error: { code: -32601, message: 'Method not found' } });
  assert.equal(seen.length, 0);
  const bad = await post('{"method":"tools/call"}');
  assert.equal(bad.status, 400);
  assert.equal(seen.length, 0);
});

test('an allowed method goes through with its body and comes back', async () => {
  const body = JSON.stringify(rpc('tools/call', 6, { name: 'GetLiveContext', arguments: {} }));
  const res = await post(body);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { jsonrpc: '2.0', id: 6, result: { ok: true } });
  assert.deepEqual(seen, [{ method: 'POST', body }]);
});

test('a body over the limit is refused unread', async () => {
  const res = await post(JSON.stringify(rpc('tools/call', 1, { pad: 'x'.repeat(MAX_BODY_BYTES) })));
  assert.equal(res.status, 413);
  assert.equal(seen.length, 0);
});

test('a server request in a JSON answer is dropped', async () => {
  reply = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(rpc('sampling/createMessage', 'srv-1', {})));
  };
  const res = await post(rpc('tools/list', 1));
  assert.equal(res.status, 202);
  assert.equal(await res.text(), '');
});

test('a success Home Assistant sends in another format carries nothing; an error status passes', async () => {
  reply = (req, answer) => { answer.writeHead(200, { 'content-type': 'text/html' }); answer.end('<p>hi</p>'); };
  let res = await post(rpc('ping', 1));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '');
  assert.equal(res.headers.get('content-type'), null);
  reply = (req, answer) => { answer.writeHead(405, { 'content-type': 'text/plain' }); answer.end('405: Method Not Allowed'); };
  res = await fetch(`${relay.url}/api/mcp`, { headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' } });
  assert.equal(res.status, 405);
  assert.equal(await res.text(), '405: Method Not Allowed');
});

// A request with a body the relay must not judge: fetch refuses to send one on
// GET, so this goes through node:http, with a length or chunked.
function sendWithBody(method, path, body, chunked) {
  return new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    if (chunked) headers['transfer-encoding'] = 'chunked';
    else headers['content-length'] = String(Buffer.byteLength(body));
    const req = http.request(`${relay.url}${path}`, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    if (chunked) req.write(body);
    req.end(chunked ? undefined : body);
  });
}

test('only POST carries a body to Home Assistant: any other request with one is refused', async () => {
  const body = JSON.stringify(rpc('resources/read', 9, { uri: 'homeassistant://assist/context-snapshot' }));
  for (const method of ['GET', 'DELETE']) {
    for (const chunked of [false, true]) {
      const res = await sendWithBody(method, '/api/mcp', body, chunked);
      assert.equal(res.status, 400, `${method} chunked=${chunked}`);
      assert.deepEqual(JSON.parse(res.text), { error: `a ${method} request carries no body` });
      assert.doesNotMatch(res.text, /result/);
    }
  }
  const camera = await sendWithBody('GET', '/api/camera_proxy/camera.door', body, false);
  assert.equal(camera.status, 400);
  assert.equal(seen.length, 0, 'nothing reached Home Assistant');
});

test('a GET or DELETE without a body reaches Home Assistant without one', async () => {
  const empty = await sendWithBody('DELETE', '/api/mcp', '', false);
  assert.equal(empty.status, 200);
  const res = await fetch(`${relay.url}/api/mcp`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, [{ method: 'DELETE', body: '' }, { method: 'GET', body: '' }]);
});

test('the server stream (GET) is filtered and still streams; DELETE ends a session', async () => {
  reply = (req, res) => {
    if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify(rpc('roots/list', 'srv-2'))}\n\n`);
    res.write(`data: ${JSON.stringify(rpc('notifications/message', undefined, { level: 'info' }))}\n\n`);
    setTimeout(() => { res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n\n`); res.end(); }, 30);
  };
  const res = await fetch(`${relay.url}/api/mcp`, { headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' } });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const first = Buffer.from((await reader.read()).value).toString('utf8');
  assert.match(first, /notifications\/message/, 'an allowed event arrives before the stream ends');
  assert.doesNotMatch(first, /roots\/list/);
  let rest = '';
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += Buffer.from(chunk.value).toString('utf8');
  assert.match(rest, /"result"/);
  assert.doesNotMatch(first + rest, /roots\/list/);
  const del = await fetch(`${relay.url}/api/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(del.status, 200);
  assert.deepEqual(seen.map((s) => s.method), ['GET', 'DELETE']);
});
