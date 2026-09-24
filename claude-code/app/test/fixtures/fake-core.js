'use strict';

// A Home Assistant Core for the integration suite: just enough for the prompt
// server's device lookup to run through the real relay. The live-context tool
// answers the way Home Assistant does — exposed devices by names, domain and
// areas, never by entity id — and matches a name by any of the device's names
// or by its exact entity id; `/api/states` carries the friendly names.

const http = require('node:http');

// The home the stub model names devices in (fixtures/claude-stub.js).
const HOME = [
  { id: 'switch.heater', name: 'Heater', area: 'Office' },
  { id: 'light.living_room', name: 'Living Room Light', area: 'Living Room' },
  { id: 'person.me', name: 'Me' },
];

const norm = (s) => String(s).trim().toLowerCase();

function dump(entities) {
  return ['Live Context: An overview of the areas and the devices in this smart home:',
    ...entities.flatMap((e) => [
      `- names: ${e.name}`,
      `  domain: ${e.id.split('.')[0]}`,
      "  state: 'on'",
      ...(e.area ? [`  areas: ${e.area}`] : []),
    ])].join('\n');
}

function liveContext({ name, domain }) {
  const hits = HOME.filter((e) => (domain
    ? e.id.startsWith(`${domain}.`)
    : e.id === name || norm(e.name) === norm(name)));
  if (hits.length === 0) return { success: false, error: `No device or entity named ${name}` };
  return { success: true, result: dump(hits) };
}

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function answerMcp({ id, method, params }) {
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: [{ name: 'GetLiveContext', inputSchema: { type: 'object' } }] } };
  }
  if (method === 'tools/call' && params && params.name === 'GetLiveContext') {
    const text = JSON.stringify(liveContext(params.arguments || {}));
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } };
}

/** Start it on a port the system picks; resolves to {origin, close}. */
function startFakeCore() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/api/states') {
        reply(res, 200, HOME.map((e) => ({ entity_id: e.id, state: 'on', attributes: { friendly_name: e.name } })));
      } else if (req.method === 'POST' && req.url === '/api/mcp') {
        let rpc;
        try { rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { rpc = {}; }
        reply(res, 200, answerMcp(rpc));
      } else {
        reply(res, 404, { message: 'not found' });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      origin: `http://127.0.0.1:${server.address().port}`,
      close: () => { server.closeAllConnections(); server.close(); },
    }));
  });
}

module.exports = { startFakeCore, HOME };
