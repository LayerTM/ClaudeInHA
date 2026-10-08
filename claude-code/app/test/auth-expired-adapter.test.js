'use strict';

// The adapter's half of the auth-expired contract: the decoder flags a
// rejected credential on the result event, and credentialsExpiry reads the
// local file's own deadlines. Both fixtures below are real stream-json lines
// captured from Claude CLI 2.1.294 (one from an invalid OAuth token, one from
// a session whose refresh token had already expired server-side) — not
// hand-written approximations of the shape.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDecoder } = require('../adapter/runner');
const adapter = require('../adapter');

function decodeAll(events) {
  const decode = createDecoder();
  return events.flatMap((ev) => decode(ev));
}

test('an invalid OAuth token flags the result event as auth-expired', () => {
  const events = [
    {
      type: 'assistant',
      message: {
        id: '1', model: '<synthetic>', role: 'assistant', type: 'message',
        content: [{ type: 'text', text: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.' }],
      },
      session_id: 's', uuid: 'u1', error: 'authentication_failed', is_api_error_message: true,
    },
    {
      type: 'result', subtype: 'success', is_error: true, api_error_status: 401,
      terminal_reason: 'api_error', result: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.',
      num_turns: 1, total_cost_usd: 0,
    },
  ];
  const [result] = decodeAll(events);
  assert.equal(result.type, 'result');
  assert.equal(result.isError, true);
  assert.equal(result.authExpired, true);
});

test('a session whose refresh token had already expired flags the same way, with no api_error_status', () => {
  // Captured 2026-10-08 against a sandbox credential whose refreshTokenExpiresAt
  // was already past: the CLI never got as far as an HTTP status.
  const events = [
    {
      type: 'assistant',
      message: {
        diagnostics: null, id: 'e7e63fcd-89de-4317-9fa8-8936e0e3622d', container: null, model: '<synthetic>',
        role: 'assistant', stop_details: null, stop_reason: 'stop_sequence', stop_sequence: '', type: 'message',
        usage: {
          output_tokens_details: null, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
          service_tier: null, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
          inference_geo: null, iterations: null, speed: null, fallback_credit: null,
        },
        content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired and could not be refreshed' }],
        context_management: null,
      },
      parent_tool_use_id: null, session_id: 'fb22ac25-3c2d-4ccc-8e04-1d783f52c5bd',
      uuid: 'd5563339-7298-41da-9a58-db3bfb82d0aa', timestamp: '2026-10-08T13:42:19.455Z',
      error: 'authentication_failed', is_api_error_message: true,
    },
    {
      duration_api_ms: 0, stop_reason: 'stop_sequence', session_id: 'fb22ac25-3c2d-4ccc-8e04-1d783f52c5bd',
      total_cost_usd: 0, modelUsage: {}, permission_denials: [], terminal_reason: 'api_error',
      is_error: true, num_turns: 1, subtype: 'success', api_error_status: null,
      result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
      type: 'result', duration_ms: 116, uuid: '3b818913-df61-4e64-bc91-6d287e2683da',
    },
  ];
  const [result] = decodeAll(events);
  assert.equal(result.type, 'result');
  assert.equal(result.isError, true);
  assert.equal(result.authExpired, true);
});

test('a result with no preceding authentication_failed event, and no matching text, is not flagged', () => {
  const events = [
    { type: 'result', subtype: 'error', is_error: true, result: 'model exploded', num_turns: 3, total_cost_usd: 0.1 },
  ];
  const [result] = decodeAll(events);
  assert.equal(result.authExpired, undefined);
});

test('a successful run is not flagged, even if an earlier turn in the same run failed once', () => {
  const events = [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] }, session_id: 's' },
    { type: 'result', subtype: 'success', is_error: false, result: 'all good', num_turns: 1, total_cost_usd: 0.01 },
  ];
  const [result] = decodeAll(events);
  assert.equal(result.authExpired, undefined);
});

test('the fallback text match catches a future CLI build that drops the structured field', () => {
  const events = [
    { type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate: something new', num_turns: 1 },
  ];
  const [result] = decodeAll(events);
  assert.equal(result.authExpired, true);
});

function withCredentials(contents, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-credexp-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  if (contents !== null) {
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify(contents));
  }
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('credentialsExpiry reads the later of the two stored deadlines', () => {
  withCredentials({ claudeAiOauth: { expiresAt: 1791476435552, refreshTokenExpiresAt: 1791459083552 } }, (home) => {
    assert.equal(adapter.prompt.credentialsExpiry({ env: {}, home }), 1791476435552);
  });
});

test('credentialsExpiry is null for an API key or a pasted token: no file-based deadline applies', () => {
  withCredentials({ claudeAiOauth: { expiresAt: 1, refreshTokenExpiresAt: 2 } }, (home) => {
    assert.equal(adapter.prompt.credentialsExpiry({ env: { ANTHROPIC_API_KEY: 'k' }, home }), null);
    assert.equal(adapter.prompt.credentialsExpiry({ env: { CLAUDE_CODE_OAUTH_TOKEN: 't' }, home }), null);
  });
});

test('credentialsExpiry is null when there is no credentials file yet', () => {
  withCredentials(null, (home) => {
    assert.equal(adapter.prompt.credentialsExpiry({ env: {}, home }), null);
  });
});

test('credentialsExpiry is null when the file has no usable timestamps', () => {
  withCredentials({ claudeAiOauth: {} }, (home) => {
    assert.equal(adapter.prompt.credentialsExpiry({ env: {}, home }), null);
  });
});
