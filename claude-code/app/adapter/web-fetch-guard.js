'use strict';

const { verdict } = require('./web-host-policy');

// PreToolUse hook for a web run's WebFetch. In `dontAsk` the CLI still allows
// its built-in set of documentation hosts next to the per-domain allowlist, so
// the allowlist alone does not make "only the listed sites" true. This hook
// runs first and denies every URL whose host is not exactly one of the listed
// domains (compared without port or trailing dot, lower-cased by URL parsing).
//
//   node web-fetch-guard.js <domain>...   (hook payload on stdin)
//
// Anything it cannot read or parse is denied.

// A hook that fails to decide must not let the fetch through: the CLI treats
// every non-zero exit but 2 as a non-blocking error, so every path out of here
// that is not an explicit allow ends in exit 2 with the reason on stderr.
function deny(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

function main() {
  const domains = process.argv.slice(2);
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('error', () => deny('the WebFetch call could not be read'));
  process.stdin.on('end', () => {
    try {
      const reason = verdict(JSON.parse(raw), domains);
      if (reason !== null) deny(reason);
    } catch {
      deny('the WebFetch call could not be checked');
    }
  });
}

process.on('uncaughtException', () => deny('the WebFetch guard failed'));
main();
