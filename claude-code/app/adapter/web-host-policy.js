'use strict';

// Which URLs a web run's WebFetch may open: exactly the listed domains, compared
// as host without port or trailing dot (URL parsing lower-cases it).

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/\.$/, '');
  } catch {
    return null;
  }
}

// null when the call may go ahead, else the reason it is denied.
function verdict(payload, domains) {
  const url = payload && payload.tool_input && payload.tool_input.url;
  const host = hostOf(url);
  if (host === null) return 'WebFetch needs a valid URL';
  if (!domains.includes(host)) return `${host} is not a site this run may open`;
  return null;
}

module.exports = { verdict, hostOf };
