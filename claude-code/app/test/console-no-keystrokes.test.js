'use strict';

// The console's terminal layer must never synthesise input into the shared Claude
// window. There is one session behind every browser tab, so anything typed at the
// program on one viewer's behalf happens to all of them.
//
// What happened: a "status-line nudge" sent the clear-screen key to the shared
// window — three times on every connect and again after every resize — meaning to
// make Claude re-render its cached status bar at the browser's width. Its comment
// asserted that key only repaints. In Claude's interface it CLEARS, so each nudge
// wiped the visible transcript for every viewer at once. Users saw the console go
// blank on its own; it needed no second browser, only a reconnect.
//
// Two measurements settle why it is deleted rather than replaced. A bare pty
// resize (SIGWINCH) already makes the TUI repaint at the new width — 120 to 64
// columns repaints at exactly 64, and back at exactly 120, with nothing sent to
// it. And the nudge never did the job it existed for either: instrumenting the
// statusLine command shows it is NOT re-run, by the resize or by the key. The
// machinery was destructive and useless at once.
//
// The rule this pins outlives that one key: a keystroke is the APPLICATION's
// alphabet, not the terminal's. What the terminal wants to say — you changed
// size, repaint — it says with a terminal mechanism.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const SERVER = path.join(__dirname, '..', 'server');

// --- Behavioural guard -------------------------------------------------------
// The real check: drive attach() with a stubbed pty and a recording tmux, and
// assert nothing was written into the pty and no tmux verb outside the allowed
// set was used. A source scan cannot see the likeliest way this returns —
// `term.write('\x0c')`, with the pty right there in scope — and a whitelist
// fails closed on the next mechanism nobody predicted, including a renamed one.

const writes = [];
const tmuxVerbs = new Set();

const ptyStub = {
  spawn() {
    return {
      write: (d) => writes.push(d),
      resize() {}, kill() {}, pause() {}, resume() {}, onData() {}, onExit() {},
    };
  },
};

const tmuxReal = {
  MAIN: 'main',
  workdir: () => '/tmp',
  ensureMain: async () => {},
  listWindows: async () => [{ index: 0, name: 'claude' }],
  killSession: () => {},
  selectWindow: async () => {},
  setDestroyUnattachedWithRetry: async () => {},
};
const tmuxStub = new Proxy(tmuxReal, {
  get(t, k) { if (typeof k === 'string') tmuxVerbs.add(k); return t[k]; },
});

const inject = (id, exports) => {
  const resolved = require.resolve(id);
  const m = new Module(resolved, null);
  m.filename = resolved;
  m.loaded = true;
  m.exports = exports;
  require.cache[resolved] = m;
};
inject('node-pty', ptyStub);
inject(path.join(SERVER, 'tmux.js'), tmuxStub);
const terminal = require(path.join(SERVER, 'terminal.js'));

class FakeWs {
  constructor() { this.OPEN = 1; this.readyState = 1; this.bufferedAmount = 0; this.h = {}; }
  on(e, f) { (this.h[e] ||= []).push(f); }
  emit(e, ...a) { (this.h[e] || []).forEach((f) => f(...a)); }
  send() {} close() {} ping() {} terminate() {}
}

// Everything the terminal layer is allowed to ask of the shared session. Adding
// a verb here is a deliberate act; forgetting to is a red test, not a silent one.
const ALLOWED = new Set(['MAIN', 'workdir', 'ensureMain', 'listWindows',
  'killSession', 'selectWindow', 'setDestroyUnattachedWithRetry']);

test('the terminal layer touches the shared window only through the allowed verbs', async () => {
  const ws = new FakeWs();
  terminal.attach(ws);
  await new Promise((r) => setTimeout(r, 60));
  ws.emit('message', Buffer.from(JSON.stringify({ t: 'resize', cols: 64, rows: 24 })), false);
  ws.emit('message', Buffer.from(JSON.stringify({ t: 'resize', cols: 120, rows: 24 })), false);
  // Long enough to outlive both deleted timers: the earliest connect-time nudge
  // fired at 3s and the resize nudge was debounced by 500ms. A shorter wait would
  // pass on the buggy code too.
  await new Promise((r) => setTimeout(r, 4000));
  assert.deepEqual(writes, [],
    `bytes synthesised into the shared pty: ${JSON.stringify(writes)}`);
  assert.deepEqual([...tmuxVerbs].filter((k) => !ALLOWED.has(k)), [],
    'a verb outside the allowed set was used on the shared window');
  ws.emit('close');
});

// --- Source guard, second line ----------------------------------------------
// Cheap, and it reaches code paths the behavioural test never drives. It does NOT
// strip comments: a stripper is code that can eat code — two ordinary string
// literals spelling a block-comment delimiter blinded the first version of this
// file and hid a live violation. Instead the prose above simply avoids the
// literals, which needs no parser and cannot be wrong.
//
// Scoped to the two files that OWN the shared console session. Scanning all of
// server/ was wrong in the other direction: the prompt subsystem runs a separate
// per-request child with no shared window, and its JSON escape table (`f: '\f'`)
// is a form feed that means nothing here. A guard whose alarms are mostly false
// gets switched off.

const OWNS_SHARED_SESSION = ['terminal.js', 'tmux.js'].map((f) => path.join(SERVER, f));

test('the files owning the shared session do not type at it', () => {
  const offenders = [];
  for (const file of OWNS_SHARED_SESSION) {
    const src = fs.readFileSync(file, 'utf8');
    if (/send-keys/.test(src)) offenders.push(`${path.basename(file)}: tmux send-keys`);
    if (/\\x0c|\\f|['"`]C-l['"`]/.test(src)) offenders.push(`${path.basename(file)}: a clear-screen byte`);
  }
  assert.deepEqual(offenders, [],
    'a redraw is SIGWINCH (term.resize), never a key typed at the application');
});
