'use strict';

// One session, several browsers: restarting Claude reaches all of them, so the
// console has to know how many are there before it offers to. This asserts the
// count is a live fact the server pushes on every attach and detach — a number
// polled a minute ago would let the warning be absent exactly when a second
// viewer has just arrived.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const SERVER = path.join(__dirname, '..', 'server');

const ptyStub = {
  spawn() {
    return {
      write() {}, resize() {}, kill() {}, pause() {}, resume() {},
      onData() {}, onExit() {},
    };
  },
};

const tmuxStub = {
  MAIN: 'main',
  workdir: () => '/tmp',
  ensureMain: async () => {},
  listWindows: async () => [{ index: 0, name: 'claude' }],
  killSession: () => {},
  selectWindow: async () => {},
  setDestroyUnattachedWithRetry: async () => {},
};

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
  constructor() {
    this.OPEN = 1;
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.h = {};
    this.sent = [];
  }

  on(e, f) { (this.h[e] ||= []).push(f); }
  emit(e, ...a) { (this.h[e] || []).forEach((f) => f(...a)); }
  send(data) { if (typeof data === 'string') this.sent.push(JSON.parse(data)); }
  close() {} ping() {} terminate() {}
  // The counts this client was told about, oldest first.
  counts() { return this.sent.filter((m) => m.t === 'viewers').map((m) => m.n); }
}

const settle = async (n = 20) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};

test('every viewer is told how many are attached, as it changes', async () => {
  assert.equal(terminal.viewerCount(), 0, 'nobody attached yet');

  const first = new FakeWs();
  terminal.attach(first);
  await settle();
  assert.equal(terminal.viewerCount(), 1);
  assert.deepEqual(first.counts(), [1], 'the first viewer is told it is alone');

  const second = new FakeWs();
  terminal.attach(second);
  await settle();
  assert.equal(terminal.viewerCount(), 2);
  assert.deepEqual(
    first.counts(), [1, 2],
    'the one already there learns a second arrived — without asking',
  );
  assert.deepEqual(second.counts(), [2], 'and the new one knows it is not alone');

  second.emit('close');
  await settle();
  assert.equal(terminal.viewerCount(), 1);
  assert.deepEqual(
    first.counts(), [1, 2, 1],
    'and learns when it is alone again, so the warning stops being shown',
  );

  first.emit('close');
  await settle();
  assert.equal(terminal.viewerCount(), 0);
});
