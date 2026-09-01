'use strict';

// A loopback relay in front of Home Assistant Core.
//
// Why it exists, in one sentence: it is the single place that holds the Home
// Assistant token and decides how to reach Core, so nothing else has to.
//
// Two problems it solves at once.
//
// 1. TLS on Core. When Core terminates TLS itself, the certificate is issued for
//    the name users type from outside, while the add-on reaches Core over the
//    internal docker network as `homeassistant`. The names cannot match, by
//    construction — so certificate verification on this hop can never pass and
//    protects nothing. The hop does not leave the host. Home Assistant's own
//    Supervisor reached the same conclusion: it talks to Core over a unix socket
//    where it can, and over the network it connects by IP with verification off
//    (`supervisor/homeassistant/api.py` — `api_authority`, and `ssl=False` on its
//    Core requests). We do the same, and only ever to the address WE derive from
//    the Supervisor — never to a user-supplied host, so there is no destination
//    an attacker could point the token at.
//
//    The relay is what makes that possible at all for MCP: the TLS peer there is
//    the bundled `claude` CLI, not our code, and the MCP config we write it
//    carries only {type, url, headers} — there is no TLS knob to set. Pointing
//    the CLI at plain HTTP on loopback moves the TLS decision back to us.
//
// 2. The child process no longer holds a Home Assistant credential. Before, the
//    spawned `claude` read the LLAT out of its MCP config. Now it gets a
//    per-boot relay token that is useless anywhere else, and the LLAT stays in
//    this process.
//
// The relay is deliberately narrow: loopback only, one bearer token, and an
// exact allowlist of the two paths the add-on actually uses.

const http = require('node:http');
const https = require('node:https');

// Exactly what the add-on needs, and nothing else.
const MCP_PATH = '/api/mcp';
const MCP_METHODS = new Set(['POST', 'GET', 'DELETE']);
const CAMERA_PATH_RE = /^\/api\/camera_proxy\/[a-z_]+\.[a-z0-9_]+$/;

// Headers copied client -> Core. `authorization` is deliberately absent: it is
// replaced, never forwarded. The MCP set matches what the Supervisor's own proxy
// forwards for streamable HTTP.
const FORWARD_TO_CORE = new Set([
  'accept',
  'accept-language',
  'content-type',
  'content-length',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
]);

// Headers copied Core -> client. Session id must survive or MCP cannot resume.
const FORWARD_TO_CLIENT = new Set([
  'content-type',
  'content-length',
  'cache-control',
  'mcp-session-id',
]);

function allowed(method, pathname) {
  if (pathname === MCP_PATH) return MCP_METHODS.has(method);
  if (method === 'GET' && CAMERA_PATH_RE.test(pathname)) return true;
  return false;
}

function deny(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

/**
 * Start the relay.
 *
 * @param {object} opts
 * @param {string} opts.coreOrigin  Origin derived from the Supervisor (never user input).
 * @param {string} opts.haToken     The Home Assistant LLAT. Stays in this process.
 * @param {string} opts.relayToken  Per-boot bearer the local client must present.
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{url: string, port: number, close: () => void}>}
 */
async function startCoreRelay({ coreOrigin, haToken, relayToken, log = () => {} }) {
  const target = new URL(coreOrigin);
  const secure = target.protocol === 'https:';
  const transport = secure ? https : http;

  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    } catch {
      deny(res, 400, 'bad request');
      return;
    }

    const auth = req.headers.authorization || '';
    // Constant-time comparison is not warranted here: the token never leaves
    // loopback, and an attacker able to time it is already inside the container.
    if (auth !== `Bearer ${relayToken}`) {
      deny(res, 401, 'unauthorized');
      req.resume();
      return;
    }
    if (!allowed(req.method, pathname)) {
      deny(res, 404, 'not found');
      req.resume();
      return;
    }

    const headers = { authorization: `Bearer ${haToken}` };
    for (const [name, value] of Object.entries(req.headers)) {
      if (FORWARD_TO_CORE.has(name)) headers[name] = value;
    }

    const upstream = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: pathname,
        headers,
        // See the header comment: the name in the certificate cannot match the
        // internal one, the hop never leaves the host, and the destination is
        // derived by us rather than supplied by anyone.
        ...(secure ? { rejectUnauthorized: false } : {}),
      },
      (upRes) => {
        // A redirect is never followed: node does not follow by default, and the
        // Authorization header must not travel to another origin. Surfaced as a
        // plain error so it cannot be mistaken for an auth failure.
        if (upRes.statusCode >= 300 && upRes.statusCode < 400) {
          upRes.resume();
          deny(res, 502, `core returned a redirect (${upRes.statusCode}) — not followed`);
          return;
        }
        const out = {};
        for (const [name, value] of Object.entries(upRes.headers)) {
          if (FORWARD_TO_CLIENT.has(name)) out[name] = value;
        }
        res.writeHead(upRes.statusCode, out);
        // Piped, not buffered: MCP streams server-sent events over this hop.
        upRes.pipe(res);
      },
    );

    upstream.on('error', (err) => {
      log(`relay upstream error: ${err.message}`);
      if (!res.headersSent) deny(res, 502, 'core unreachable');
      else res.end();
    });

    req.pipe(upstream);
  });

  await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  }));
  server.on('error', (err) => log(`relay server error: ${err.message}`));

  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}

module.exports = { startCoreRelay, allowed, CAMERA_PATH_RE, MCP_PATH };
