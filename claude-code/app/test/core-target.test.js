'use strict';

// Tests for core-target.js — where the add-on decides Home Assistant Core is.
// The regression it guards (ClaudeInHA#47): the address used to be the literal
// `http://homeassistant:8123`, which is wrong for anyone terminating TLS on Core
// or running it on another port.
//
// The load-bearing case is the FIRST one: on an ordinary install the derived
// string must be byte-identical to the old literal, or this change is not the
// no-op it claims to be.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveCoreTarget } = require('../server/prompt/core-target');

const LITERAL = 'http://homeassistant:8123';

function stubFetch(payload, { ok = true, status = 200, throws = null } = {}) {
  return async () => {
    if (throws) throw throws;
    return { ok, status, json: async () => payload };
  };
}

test('ordinary install: derived origin is byte-identical to the old literal', async () => {
  const target = await resolveCoreTarget({
    supervisorToken: 't',
    fetchImpl: stubFetch({ data: { ssl: false, port: 8123, ip_address: '172.30.32.1' } }),
  });
  assert.equal(target.origin, LITERAL);
  assert.equal(target.ssl, false);
  assert.equal(target.source, 'supervisor core/info');
});

test('TLS on Core: scheme follows the Supervisor, not a guess', async () => {
  const target = await resolveCoreTarget({
    supervisorToken: 't',
    fetchImpl: stubFetch({ data: { ssl: true, port: 8123 } }),
  });
  assert.equal(target.origin, 'https://homeassistant:8123');
  assert.equal(target.ssl, true);
});

test('non-default port is honoured', async () => {
  const target = await resolveCoreTarget({
    supervisorToken: 't',
    fetchImpl: stubFetch({ data: { ssl: false, port: 8124 } }),
  });
  assert.equal(target.origin, 'http://homeassistant:8124');
});

test('TLS and a moved port together', async () => {
  const target = await resolveCoreTarget({
    supervisorToken: 't',
    fetchImpl: stubFetch({ data: { ssl: true, port: 443 } }),
  });
  assert.equal(target.origin, 'https://homeassistant:443');
});

// Every failure path must land on the historic literal: a resolver that cannot
// answer has to leave behaviour exactly as it was, never break the add-on.
const failures = [
  ['no supervisor token', { supervisorToken: '', fetchImpl: stubFetch({}) }],
  ['HTTP error from the Supervisor', {
    supervisorToken: 't', fetchImpl: stubFetch({}, { ok: false, status: 403 }),
  }],
  ['network failure', {
    supervisorToken: 't', fetchImpl: stubFetch({}, { throws: new Error('ECONNREFUSED') }),
  }],
  ['payload with no data', { supervisorToken: 't', fetchImpl: stubFetch({ result: 'ok' }) }],
  ['data is not an object', { supervisorToken: 't', fetchImpl: stubFetch({ data: 'nope' }) }],
];

for (const [name, opts] of failures) {
  test(`falls back to the literal: ${name}`, async () => {
    const target = await resolveCoreTarget(opts);
    assert.equal(target.origin, LITERAL);
    assert.equal(target.ssl, false);
    assert.match(target.source, /^default/);
  });
}

// A nonsense port must not produce a nonsense origin — the scheme is still
// worth keeping, so these fall back to the default port rather than the default
// origin.
for (const port of [0, -1, 99999, '8123', null, undefined, 1.5]) {
  test(`unusable port ${JSON.stringify(port)} falls back to 8123`, async () => {
    const target = await resolveCoreTarget({
      supervisorToken: 't',
      fetchImpl: stubFetch({ data: { ssl: true, port } }),
    });
    assert.equal(target.origin, 'https://homeassistant:8123');
  });
}

test('ssl is only true for a real boolean true', async () => {
  for (const ssl of ['true', 1, {}, null, undefined]) {
    const target = await resolveCoreTarget({
      supervisorToken: 't',
      fetchImpl: stubFetch({ data: { ssl, port: 8123 } }),
    });
    assert.equal(target.origin, LITERAL, `ssl=${JSON.stringify(ssl)} must not enable https`);
  }
});
