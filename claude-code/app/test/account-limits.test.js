'use strict';

// Tests for /api/account_limits — the account's rate-limit utilisation.
//
// The endpoint answers for something the add-on cannot see for itself, so every
// case here is about what it says when it CANNOT know: an API-key install (no
// such limits exist upstream — an empty list, not an error, so the consumer
// builds no entities), no credentials at all, an upstream that refuses, and an
// upstream whose answer does not have the shape it claims. A limit reported as
// 0 % would read as "plenty left", which is why none of those paths may produce
// a number.
//
// The upstream call is injected (`limitsFetch`), so nothing here touches the
// network and the stub can also count how often it was called — that is how the
// cache and the shared in-flight call are asserted.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPromptApp } = require('../server/prompt/server');

const TOKEN = 'account-limits-test-token-000000000000';

// The account's own answer, as measured on a real account: `limits` plus other
// top-level keys that are internal and must not reach the client.
const UPSTREAM = {
  internal_bookkeeping: { not: 'ours' },
  limits: [
    { kind: 'session', percent: 14, severity: 'normal', resets_at: '2026-09-14T15:30:00+00:00', scope: null },
    { kind: 'weekly_all', percent: 82, severity: 'warning', resets_at: '2026-09-16T13:00:00+00:00', scope: null },
    {
      kind: 'weekly_scoped',
      percent: 88,
      severity: 'warning',
      resets_at: '2026-09-16T13:00:00+00:00',
      scope: { model: { display_name: 'Fable' } },
    },
  ],
};

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

function build({ apiKey = '', oauthToken = '', homeDir = '', upstream }) {
  const calls = [];
  const limitsFetch = async (url, init) => {
    calls.push({ url, init });
    return upstream(url, init);
  };
  const app = createPromptApp({
    token: TOKEN,
    claudeBin: '/bin/true',
    usageBin: '/bin/true',
    mcpConfigPath: '',
    model: '',
    workDir: os.tmpdir(),
    addonVersion: 'test',
    redact: (x) => x,
    audit: () => {},
    apiKey,
    oauthToken,
    homeDir,
    limitsFetch,
    haConfigured: false,
  });
  return { app, calls };
}

// One server per test, several requests allowed against it (the cache and the
// in-flight guard live in the app instance, so they need the same one).
async function serve(app) {
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  return {
    async get({ auth = true } = {}) {
      const res = await fetch(`${base}/api/account_limits`, auth
        ? { headers: { Authorization: `Bearer ${TOKEN}` } }
        : {});
      return { status: res.status, body: await res.json() };
    },
    close: () => srv.close(),
  };
}

test('api key only: an empty list with the mode, and upstream is never asked', async () => {
  // An API key is billed per request and has no limit buckets upstream. Asking
  // anyway would answer about the wrong thing, so the call must not happen at
  // all — and the answer must be a 200, because "no limits exist" is knowledge,
  // not a failure: the integration creates no sensors rather than broken ones.
  const { app, calls } = build({
    apiKey: 'sk-ant-api03-EXAMPLE0000000000',
    upstream: () => { throw new Error('upstream must not be called for an API key'); },
  });
  const srv = await serve(app);
  try {
    const { status, body } = await srv.get();
    assert.equal(status, 200);
    assert.equal(body.mode, 'api_key');
    assert.deepEqual(body.limits, []);
    assert.match(body.fetched_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(calls.length, 0, 'no upstream call for an API-key install');
  } finally { srv.close(); }
});

test('subscription: the account\'s limits, mapped to the contract', async () => {
  const { app, calls } = build({
    oauthToken: 'oauth-access-token-from-the-option',
    upstream: () => jsonResponse(UPSTREAM),
  });
  const srv = await serve(app);
  try {
    const { status, body } = await srv.get();
    assert.equal(status, 200);
    assert.equal(body.mode, 'subscription');
    assert.deepEqual(body.limits, [
      { kind: 'session', percent: 14, severity: 'normal', resets_at: '2026-09-14T15:30:00+00:00', model: null },
      { kind: 'weekly_all', percent: 82, severity: 'warning', resets_at: '2026-09-16T13:00:00+00:00', model: null },
      { kind: 'weekly_scoped', percent: 88, severity: 'warning', resets_at: '2026-09-16T13:00:00+00:00', model: 'Fable' },
    ]);
    // Nothing else from upstream is exposed.
    assert.deepEqual(Object.keys(body).sort(), ['fetched_at', 'limits', 'mode']);
    const { init } = calls[0];
    assert.equal(init.headers.Authorization, 'Bearer oauth-access-token-from-the-option');
    assert.equal(init.headers['anthropic-beta'], 'oauth-2025-04-20');
  } finally { srv.close(); }
});

test('interactive login: the token is read from the credential file, at call time', async () => {
  // The user who logs in with `claude` has no option set and no environment
  // variable — only the file the CLI writes. Reading it per call is what lets a
  // login that happens after the add-on started work without a restart.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-limits-home-'));
  fs.mkdirSync(path.join(home, '.claude'));
  const { app, calls } = build({ homeDir: home, upstream: () => jsonResponse(UPSTREAM) });
  const srv = await serve(app);
  try {
    const before = await srv.get();
    assert.equal(before.status, 503, 'no credentials yet → nothing to report');
    assert.equal(calls.length, 0);

    fs.writeFileSync(
      path.join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'token-from-the-login', refreshToken: 'r', expiresAt: 1 } }),
    );
    const after = await srv.get();
    assert.equal(after.status, 200);
    assert.equal(after.body.mode, 'subscription');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer token-from-the-login');
  } finally {
    srv.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('no credentials at all: 503, never an empty success', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-limits-none-'));
  const { app, calls } = build({ homeDir: home, upstream: () => jsonResponse(UPSTREAM) });
  const srv = await serve(app);
  try {
    const { status, body } = await srv.get();
    assert.equal(status, 503);
    assert.deepEqual(body, { error: 'account limits unavailable', code: 'limits_unavailable' });
    assert.equal(calls.length, 0);
  } finally {
    srv.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('upstream refuses (401 expired, 500 broken): 503, no numbers invented', async () => {
  for (const code of [401, 500]) {
    const { app } = build({
      oauthToken: 'expired-or-revoked',
      upstream: () => jsonResponse({ error: 'nope' }, code),
    });
    const srv = await serve(app);
    try {
      const { status, body } = await srv.get();
      assert.equal(status, 503, `upstream ${code} → 503`);
      assert.deepEqual(body, { error: 'account limits unavailable', code: 'limits_unavailable' });
    } finally { srv.close(); }
  }
});

test('upstream unreachable: 503 rather than a throw', async () => {
  const { app } = build({
    oauthToken: 'token',
    upstream: () => { throw new Error('network down'); },
  });
  const srv = await serve(app);
  try {
    assert.equal((await srv.get()).status, 503);
  } finally { srv.close(); }
});

test('an answer that is not the shape it claims: 503, and never a 0 %', async () => {
  const payloads = [
    { limits: 'not-a-list' },
    {},
    { limits: [{ kind: 'session', percent: '14' }] },   // a string where a number is promised
    { limits: [null] },
    { limits: [{ percent: 14 }] },                      // no kind: nothing to name the sensor
  ];
  for (const payload of payloads) {
    const { app } = build({ oauthToken: 'token', upstream: () => jsonResponse(payload) });
    const srv = await serve(app);
    try {
      const { status, body } = await srv.get();
      assert.equal(status, 503, `unparsable ${JSON.stringify(payload)} → 503`);
      assert.deepEqual(body, { error: 'account limits unavailable', code: 'limits_unavailable' });
    } finally { srv.close(); }
  }
});

test('a kind we have never seen passes through unchanged', async () => {
  // The list is the account's, not ours. A new bucket is still a real limit the
  // user is subject to, so it must reach the client rather than be filtered out.
  const { app } = build({
    oauthToken: 'token',
    upstream: () => jsonResponse({
      limits: [{ kind: 'monthly_experimental', percent: 3, severity: 'unheard-of', resets_at: null, scope: null }],
    }),
  });
  const srv = await serve(app);
  try {
    const { body } = await srv.get();
    assert.deepEqual(body.limits, [{
      kind: 'monthly_experimental', percent: 3, severity: 'unheard-of', resets_at: null, model: null,
    }]);
  } finally { srv.close(); }
});

test('cached for minutes, and concurrent callers share one upstream call', async () => {
  let resolveUpstream;
  const gate = new Promise((r) => { resolveUpstream = r; });
  const { app, calls } = build({
    oauthToken: 'token',
    upstream: async () => { await gate; return jsonResponse(UPSTREAM); },
  });
  const srv = await serve(app);
  try {
    const both = Promise.all([srv.get(), srv.get()]);
    resolveUpstream();
    const [first, second] = await both;
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(calls.length, 1, 'two callers at once share the in-flight call');

    const third = await srv.get();
    assert.equal(third.status, 200);
    assert.equal(calls.length, 1, 'and the answer is cached, not re-fetched');
    assert.equal(third.body.fetched_at, first.body.fetched_at, 'a cached answer keeps the time it was fetched');
  } finally { srv.close(); }
});

test('percent is an integer, and a missing severity is null rather than empty', async () => {
  // A gauge has no use for 82.4999, and '' would read as a severity the account
  // actually reported — `resets_at` already answers null for the same situation.
  const { app } = build({
    oauthToken: 'token',
    upstream: () => jsonResponse({ limits: [{ kind: 'session', percent: 82.4999, resets_at: null, scope: null }] }),
  });
  const srv = await serve(app);
  try {
    const { body } = await srv.get();
    assert.deepEqual(body.limits, [{
      kind: 'session', percent: 82, severity: null, resets_at: null, model: null,
    }]);
  } finally { srv.close(); }
});

test('a percent outside 0-100 is not a percentage: 503', async () => {
  for (const percent of [-5, 140]) {
    const { app } = build({
      oauthToken: 'token',
      upstream: () => jsonResponse({ limits: [{ kind: 'session', percent }] }),
    });
    const srv = await serve(app);
    try {
      const { status, body } = await srv.get();
      assert.equal(status, 503, `percent ${percent} → 503`);
      assert.deepEqual(body, { error: 'account limits unavailable', code: 'limits_unavailable' });
    } finally { srv.close(); }
  }
});

test('the cache belongs to the credential: after a re-login it is not reused', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-limits-relogin-'));
  fs.mkdirSync(path.join(home, '.claude'));
  const login = (accessToken) => fs.writeFileSync(
    path.join(home, '.claude', '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken } }),
  );
  login('token-of-account-one');
  const { app, calls } = build({ homeDir: home, upstream: () => jsonResponse(UPSTREAM) });
  const srv = await serve(app);
  try {
    assert.equal((await srv.get()).status, 200);
    assert.equal(calls.length, 1);
    assert.equal((await srv.get()).status, 200);
    assert.equal(calls.length, 1, 'the same credential is served from the cache');

    login('token-of-account-two');
    assert.equal((await srv.get()).status, 200);
    assert.equal(calls.length, 2, 'another account is fetched, never answered with the first one\'s figures');
    assert.equal(calls[1].init.headers.Authorization, 'Bearer token-of-account-two');
  } finally {
    srv.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the endpoint is behind the same bearer auth as the rest', async () => {
  const { app, calls } = build({ oauthToken: 'token', upstream: () => jsonResponse(UPSTREAM) });
  const srv = await serve(app);
  try {
    assert.equal((await srv.get({ auth: false })).status, 401);
    assert.equal(calls.length, 0, 'an unauthorized request never reaches upstream');
  } finally { srv.close(); }
});
