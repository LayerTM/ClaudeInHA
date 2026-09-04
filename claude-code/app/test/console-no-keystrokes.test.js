'use strict';

// The console's terminal layer must never send KEYSTROKES to the shared Claude
// window. This is a source-level guard on purpose: the damage only appears with a
// real tmux and a real TUI, so no unit test of the module's behaviour can see it,
// and the defect it prevents shipped once already with a comment asserting it was
// safe.
//
// What happened: a "status-line nudge" sent Ctrl+L to the shared window — three
// times on every connect and again after every resize — to make Claude re-render
// its cached status line at the browser's width. In Claude's TUI Ctrl+L is CLEAR,
// not repaint, and the window is shared, so each nudge wiped the visible
// transcript for every viewer at once. Users saw the console go blank on its own;
// it needed no second browser, only a reconnect.
//
// The general rule this pins, which outlives that one key: a keystroke is the
// APPLICATION's alphabet, not the terminal's. Anything the terminal wants to say
// — repaint, you changed size — it says with a terminal mechanism (SIGWINCH via a
// pty resize), never by typing at the program.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server');
const sourcesUnder = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name);
  if (e.isDirectory()) return sourcesUnder(full);
  return e.isFile() && e.name.endsWith('.js') ? [full] : [];
});

test('the terminal layer sends no keystrokes into the shared Claude window', () => {
  const offenders = [];
  for (const file of sourcesUnder(SERVER)) {
    const src = fs.readFileSync(file, 'utf8');
    // Strip comments, so the explanation above (which names the key) is not
    // itself a hit — a guard that its own rationale trips is a guard nobody keeps.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    if (/send-keys/.test(code)) offenders.push(`${path.basename(file)}: tmux send-keys`);
    if (/['"`]C-l['"`]/.test(code)) offenders.push(`${path.basename(file)}: a literal Ctrl+L`);
  }
  assert.deepEqual(offenders, [],
    'a redraw is SIGWINCH (term.resize), never a key typed at the application');
});

test('tmux exposes no keystroke-based redraw', () => {
  const tmux = require('../server/tmux');
  assert.strictEqual(tmux.redrawClaude, undefined,
    'redrawClaude sent Ctrl+L, which clears the screen for every viewer');
  // The legitimate way to restart the window is still there, so this is a
  // deletion of one mechanism rather than of the capability.
  assert.strictEqual(typeof tmux.respawnClaude, 'function');
});
