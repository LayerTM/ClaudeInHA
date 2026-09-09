'use strict';

// Who may talk to the console's listeners. Ingress requests arrive exclusively
// from the Supervisor gateway; loopback is allowed for the add-on watchdog and
// in-container tooling. Shared by the console and by the startup placeholder
// that holds the same port before it — one statement of the rule, so the two
// cannot drift apart and leave the placeholder more open than the thing it
// stands in for.
const ALLOWED_SOURCES = new Set([
  '172.30.32.2', '::ffff:172.30.32.2',
  '127.0.0.1', '::1', '::ffff:127.0.0.1',
]);

/**
 * @param {{ remoteAddress?: string }} socket
 * @param {boolean} dev when true, everything is allowed (local development)
 */
function sourceAllowed(socket, dev) {
  return dev || ALLOWED_SOURCES.has(socket.remoteAddress || '');
}

module.exports = { ALLOWED_SOURCES, sourceAllowed };
