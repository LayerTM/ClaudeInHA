'use strict';

// Menus are opened one at a time and closed by anything else happening — a click
// elsewhere, another menu, a dialog. That was a list of five menus maintained by
// hand, so the sixth (the session menu, added with the restart item) was never
// closed: it stayed open behind the dialog it had just opened.
//
// A test that named the six would be the same list one layer down, and would go
// stale the same way. This asserts the SHAPE instead: the markup declares what a
// menu is, and closeMenus must ask the markup rather than enumerate.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const closeMenusBody = () => {
  const start = APP.indexOf('function closeMenus()');
  assert.ok(start > -1, 'closeMenus exists');
  return APP.slice(start, APP.indexOf('\n  }', start));
};

test('closeMenus closes every menu the markup declares', () => {
  const body = closeMenusBody();
  assert.match(body, /querySelectorAll\('\.menu'\)/, 'it asks the markup');
  assert.match(body, /classList\.add\('hidden'\)/);
});

test('closeMenus names no individual menu', () => {
  // The regression is addition: a new menu that nobody adds to the list.
  const named = closeMenusBody().match(/els\.\w+Menu/g) || [];
  assert.deepEqual(named, [], `closeMenus must not enumerate menus, saw ${named.join(', ')}`);
});

test('every menu in the markup is one closeMenus can see', () => {
  const menus = HTML.match(/id="menu-[a-z]+"[^>]*class="menu\b/g) || [];
  assert.ok(menus.length >= 6, `expected the toolbar menus plus the context menu, saw ${menus.length}`);
  // Nothing that behaves as a menu may carry a different class and be missed.
  assert.ok(
    !/id="menu-[a-z]+"(?![^>]*class="menu\b)/.test(HTML),
    'a menu element without the .menu class would never be closed',
  );
});
