'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stampAssetVersion } = require('../server/shell');

const INDEX = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'),
  'utf8',
);

test('stamps every mutable console asset with ?v=<version>', () => {
  const out = stampAssetVersion(INDEX, '9.9.9');
  for (const asset of [
    'styles.css',
    'app.js',
    'vendor/xterm.css',
    'vendor/xterm.js',
    'vendor/addon-fit.js',
    'vendor/addon-unicode11.js',
    'vendor/addon-web-links.js',
    'vendor/addon-search.js',
    'vendor/addon-webgl.js',
  ]) {
    assert.ok(out.includes(`${asset}?v=9.9.9"`), `expected ?v= on ${asset}`);
  }
});

test('leaves no un-stamped local app.js / styles.css reference', () => {
  const out = stampAssetVersion(INDEX, '9.9.9');
  assert.ok(!/src="app\.js"/.test(out), 'app.js left un-stamped');
  assert.ok(!/href="styles\.css"/.test(out), 'styles.css left un-stamped');
});

test('does NOT stamp fonts, icons, or the manifest (stable assets)', () => {
  const out = stampAssetVersion(INDEX, '9.9.9');
  assert.ok(!out.includes('manifest.webmanifest?v='), 'manifest wrongly stamped');
  assert.ok(!/\.woff2\?v=/.test(out), 'a font was wrongly stamped');
  assert.ok(!/favicon[^"]*\?v=/.test(out), 'a favicon was wrongly stamped');
});

test('never fires inside a data-src / data-href attribute', () => {
  const html = '<img data-src="app.js"><script src="app.js"></script>';
  const out = stampAssetVersion(html, '1');
  assert.equal(out, '<img data-src="app.js"><script src="app.js?v=1"></script>');
});

test('is a no-op when there are no matching assets', () => {
  assert.equal(stampAssetVersion('<p>hi</p>', '1'), '<p>hi</p>');
});
