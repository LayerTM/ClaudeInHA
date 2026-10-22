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

function main() {
  const domains = process.argv.slice(2);
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let payload = null;
    try { payload = JSON.parse(raw); } catch { /* denied below */ }
    const reason = verdict(payload, domains);
    if (reason === null) return;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
  });
}

main();
