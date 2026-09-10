'use strict';

// There is one Claude behind every browser that opens this console, so a restart
// stops it for everyone. The console asks first — and that promise is only worth
// anything if EVERY way to start a restart goes through the asking.
//
// It is easy to lose by addition rather than by edit: a second button, wired
// straight to the endpoint because that is the shorter line to write, and the
// warning is simply not on that path. Nothing would fail; the dialog would just
// stop appearing for whoever used the new button.
//
// So this pins the shape rather than the behaviour of one button: the restart
// request is issued from exactly one place in the client, and both entry points
// (the session menu, and the button an update reveals) reach it through the
// function that counts the other viewers first.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('the restart endpoint is called from exactly one place', () => {
  const calls = APP.match(/claude\/respawn/g) || [];
  assert.strictEqual(
    calls.length, 1,
    'a second call site is a second way to restart Claude without warning anyone',
  );
});

test('every restart entry point goes through the viewer check', () => {
  const asks = APP.match(/askThenRespawn/g) || [];
  // The definition plus the two entry points that use it.
  assert.ok(asks.length >= 3, `expected the menu and the post-update button to share it, saw ${asks.length}`);
  assert.match(APP, /els\.updateRespawn\.addEventListener\('click', askThenRespawn\)/);
  assert.match(APP, /item\.dataset\.session === 'update'[\s\S]{0,80}askThenRespawn\(\)/);
  // And the check itself is what opens the dialog.
  assert.match(APP, /function askThenRespawn\(\)[\s\S]{0,400}othersWatching\(\)/);
  assert.match(APP, /function askThenRespawn\(\)[\s\S]{0,600}dlgRestart\.showModal\(\)/);
});

test('the restart is reachable without an update', () => {
  // The reason this menu exists: the post-update button appears only when an
  // update actually changed the version, so on an up-to-date install there was
  // no way to reach the restart — or the warning — at all.
  assert.match(HTML, /<button data-session="restart">[^<]*Restart Claude<\/button>/);
  assert.match(HTML, /<button data-session="update">/, 'the update keeps its own way in');
  assert.ok(!/id="btn-update"/.test(HTML), 'the old single-purpose button is gone, not left orphaned');
});
