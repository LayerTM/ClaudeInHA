'use strict';

// The Claude adapter's half of warm sessions (prompt_keep_warm) and of the text a
// turn may carry. The event lines below are what Claude CLI 2.1.322 printed for a
// `/clear` sent as a stream-json user turn (ids shortened), not hand-written shapes.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const adapter = require('../adapter');
const { SESSION, userText } = require('../adapter/runner');
const { launchSpec } = require('../server/prompt/run');

const CLEAR_EVENTS = [
  { type: 'conversation_reset', new_conversation_id: 'c1', trigger: 'clear', session_id: 's0' },
  { type: 'system', subtype: 'background_tasks_changed', tasks: [], session_id: 's0' },
  { type: 'system', subtype: 'init', cwd: '/', session_id: 's1', tools: [] },
  { type: 'result', subtype: 'success', is_error: false, num_turns: 0, duration_api_ms: 0, session_id: 's1' },
];

const ANSWER_EVENTS = [
  { type: 'system', subtype: 'init', cwd: '/', session_id: 's1', tools: [] },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] } },
  { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'OK', session_id: 's1' },
];

test('the adapter declares session support and the text rule to the core', () => {
  assert.equal(adapter.runner.session, SESSION);
  assert.equal(adapter.runner.userText, userText);
});

test('a session command line reads its turns from stdin; a fresh one does not', () => {
  const fresh = adapter.runner.launch(launchSpec({ intents: [] }), { env: {} }).args;
  const warm = adapter.runner.launch({ ...launchSpec({ intents: [] }), session: true }, { env: {} }).args;
  assert.equal(fresh.includes('--input-format'), false);
  const at = warm.indexOf('--input-format');
  assert.ok(at >= 0);
  assert.equal(warm[at + 1], 'stream-json');
  assert.equal(warm.includes('--disable-slash-commands'), false, 'the flag would remove the /clear a session needs');
});

test('the reset completes at the result after conversation_reset, not before', () => {
  const read = SESSION.createResetReader();
  assert.deepEqual(CLEAR_EVENTS.map((ev) => read(ev)), [false, false, false, true]);
});

test('an ordinary answer is never taken for a completed reset', () => {
  const read = SESSION.createResetReader();
  assert.deepEqual(ANSWER_EVENTS.map((ev) => read(ev)), [false, false, false]);
});

test('clearLine is the /clear command as a stream-json user turn', () => {
  assert.deepEqual(JSON.parse(SESSION.clearLine()), { type: 'user', message: { role: 'user', content: '/clear' } });
});

test('a turn that starts with "/" reaches the CLI as a question, not as one of its commands', () => {
  for (const text of ['/model claude-haiku-5-5', '/cost', '/clear', '/']) {
    assert.equal(userText(text), ` ${text}`);
  }
});

test('any other turn is passed unchanged, and the rule is idempotent', () => {
  for (const text of ['Is the lamp on?', ' /cost', '\n/cost', '\t/cost', 'Hi\n/cost', '', 'a/b']) {
    assert.equal(userText(text), text);
  }
  assert.equal(userText(userText('/cost')), ' /cost');
});

test('userLine carries the text it is given: the core has already made it safe', () => {
  for (const text of ['Is the lamp on?', ' /cost']) {
    assert.deepEqual(JSON.parse(SESSION.userLine(text)), { type: 'user', message: { role: 'user', content: text } });
  }
});
