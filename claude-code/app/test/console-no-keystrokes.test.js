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
// It is deleted rather than replaced because a bare pty resize (SIGWINCH) already
// makes the TUI repaint at the new width — measured against Claude 2.1.260 with
// nothing sent to it: 120 columns to 64 repaints at exactly 64, and back at
// exactly 120.
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
// Drive attach() with a stubbed pty and a recording tmux; assert nothing reached
// the pty and no tmux verb outside the allowed set was used. A source scan cannot
// see the likeliest way this returns — a write straight into the pty, which is
// right there in scope — especially once the byte is spelled with an expression
// rather than a literal.

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

// Everything the terminal layer may ask of the shared session. Adding a verb here
// is a deliberate act; forgetting to is a red test.
const ALLOWED = new Set(['MAIN', 'workdir', 'ensureMain', 'listWindows',
  'killSession', 'selectWindow', 'setDestroyUnattachedWithRetry']);

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
  get(t, k) {
    // `then` must stay absent: a module that answers it is treated as a thenable
    // and silently swallows any `await` of the module itself.
    if (typeof k !== 'string' || k === 'then') return t[k];
    tmuxVerbs.add(k);
    // A verb outside ALLOWED answers a harmless no-op rather than `undefined`.
    // Left undefined it throws a TypeError at the call, the test dies there, and
    // the assertion that would have EXPLAINED the failure never runs — so the
    // whitelist would be decoration, and the catch would be an accident of an
    // incomplete stub.
    return k in t ? t[k] : async () => {};
  },
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

const settle = async (n = 20) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};

test('the terminal layer touches the shared window only through the allowed verbs', async (t) => {
  // A VIRTUAL clock, not a wall-clock wait. The deleted nudges fired at 3s, 9s
  // AND 20s, so a test that sleeps four real seconds is green against a violation
  // planted one second later — measured, not supposed. Ticking a minute of virtual
  // time costs nothing and leaves no window to hide in.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const ws = new FakeWs();
  terminal.attach(ws);
  await settle();
  ws.emit('message', Buffer.from(JSON.stringify({ t: 'resize', cols: 64, rows: 24 })), false);
  ws.emit('message', Buffer.from(JSON.stringify({ t: 'resize', cols: 120, rows: 24 })), false);
  await settle();
  for (let i = 0; i < 60; i += 1) { t.mock.timers.tick(1000); await settle(3); }

  assert.deepEqual(writes, [],
    `bytes synthesised into the shared pty: ${JSON.stringify(writes)}`);
  assert.deepEqual([...tmuxVerbs].filter((k) => !ALLOWED.has(k)), [],
    'a verb outside the allowed set was used on the shared window');
  ws.emit('close');
});

test('one mechanism was deleted, not the capability', () => {
  // Cheap insurance that the cure did not take the patient: restarting the Claude
  // window is still possible, it just no longer happens by typing at it.
  const tmux = require(path.join(SERVER, 'tmux.js'));
  assert.strictEqual(typeof tmux.respawnClaude, 'function');
});

// --- Source scan, second line ------------------------------------------------
// Cheap, and it reaches code paths the behavioural test never drives. It does NOT
// strip comments: a stripper is code that can eat code — two ordinary string
// literals spelling a block-comment delimiter blinded an earlier version of this
// file and hid a live violation. The prose above simply avoids the literal
// tokens, which needs no parser and cannot be wrong.
//
// Every file that requires ./tmux, plus the terminal layer itself. api.js holds
// the most destructive verb in the repo (window respawn) and index.js reaches the
// session too; scoping to terminal.js and tmux.js alone left both unwatched.
// Widening to exactly these four costs no false positive — the prompt subsystem,
// which has no shared window, stays out.

const OWNS_SHARED_SESSION = ['terminal.js', 'tmux.js', 'api.js', 'index.js']
  .map((f) => path.join(SERVER, f));

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
