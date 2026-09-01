'use strict';

// Where Home Assistant Core actually listens.
//
// The add-on talks to Core over the internal docker network, which never leaves
// the host. That address was hardcoded as `http://homeassistant:8123` — true for
// almost every install, and wrong for anyone who terminates TLS on Core itself
// (`ssl_certificate` in the `http:` integration) or moved the port. There, plain
// HTTP to 8123 gets an empty reply and every Core call fails. (ClaudeInHA#47)
//
// The Supervisor already knows the answer and keeps it in sync with Core's own
// HTTP config, so ask it instead of guessing: GET /core/info reports `ssl`,
// `port` and `ip_address`.
//
// The result is derived, never user-supplied. That is deliberate: a settable
// Core URL would mean a wrong or hostile value could send the Home Assistant
// access token to another host.

const DEFAULT_HOST = 'homeassistant';
const DEFAULT_PORT = 8123;

/**
 * @typedef {{origin: string, ssl: boolean, port: number, source: string}} CoreTarget
 */

/** The address to use when the Supervisor cannot be asked — today's behaviour. */
function defaultTarget(source) {
  return {
    origin: `http://${DEFAULT_HOST}:${DEFAULT_PORT}`,
    ssl: false,
    port: DEFAULT_PORT,
    source,
  };
}

/**
 * Resolve Core's origin from the Supervisor, falling back to the historic
 * literal. Never throws: a resolution failure must degrade to the old
 * behaviour, not take the prompt server down.
 *
 * The host stays the internal DNS name rather than the reported `ip_address`
 * so container restarts that change the IP cannot stale the value.
 *
 * @param {{supervisorToken?: string, fetchImpl?: typeof fetch, timeoutMs?: number}} [opts]
 * @returns {Promise<CoreTarget>}
 */
async function resolveCoreTarget(opts = {}) {
  const {
    supervisorToken = process.env.SUPERVISOR_TOKEN,
    fetchImpl = fetch,
    timeoutMs = 10000,
  } = opts;

  if (!supervisorToken) return defaultTarget('default (no supervisor token)');

  let payload;
  try {
    const res = await fetchImpl('http://supervisor/core/info', {
      headers: { Authorization: `Bearer ${supervisorToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return defaultTarget(`default (core/info HTTP ${res.status})`);
    payload = await res.json();
  } catch (err) {
    return defaultTarget(`default (core/info failed: ${err.message})`);
  }

  const data = payload && typeof payload === 'object' ? payload.data : null;
  if (!data || typeof data !== 'object') return defaultTarget('default (core/info had no data)');

  // Both fields must be usable on their own: a sane port with a missing `ssl`
  // is still an improvement over the literal, and vice versa.
  const ssl = data.ssl === true;
  const port = Number.isInteger(data.port) && data.port > 0 && data.port < 65536
    ? data.port
    : DEFAULT_PORT;

  return {
    origin: `${ssl ? 'https' : 'http'}://${DEFAULT_HOST}:${port}`,
    ssl,
    port,
    source: 'supervisor core/info',
  };
}

module.exports = { resolveCoreTarget, defaultTarget, DEFAULT_HOST, DEFAULT_PORT };
