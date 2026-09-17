'use strict';

// The Claude run as the add-on performs it: the core's run policy with this
// add-on's adapter. Tests use these names to pin what a request turns into.

const core = require('../../server/prompt/run');
const claude = require('../../adapter/runner');

// The argument list the core has the adapter compose for one request.
function buildClaudeArgs(request) {
  return claude.launch(core.launchSpec({ ...request, intents: request.intents || [] }), { env: {} }).args;
}

module.exports = {
  buildClaudeArgs,
  runClaude: core.run,
  shutdown: core.shutdown,
  resolveHaTools: core.resolveHaTools,
  TIMEOUT_MS: core.TIMEOUT_MS,
  runTokens: claude.runTokens,
  haToolBasename: claude.toolBasename,
};
