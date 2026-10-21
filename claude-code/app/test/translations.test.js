'use strict';

// The Configuration tab shows the raw key for any option without a translation,
// and shows nothing helpful for one without a description. Options were added to
// config.yaml and to one language file at a time, so six reached users as raw
// keys. This asserts the relation instead of listing options: every option the
// add-on declares has a name and a description in every language it ships.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ADDON = path.join(__dirname, '..', '..');
const TRANSLATIONS = path.join(ADDON, 'translations');

// Keys indented two spaces directly under a top-level section.
const sectionKeys = (text, section) => {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `${section}:`);
  assert.ok(start > -1, `section "${section}" exists`);
  const keys = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) break;
    const m = /^ {2}([a-z0-9_]+):/.exec(lines[i]);
    if (m) keys.push(m[1]);
  }
  return keys;
};

const entry = (text, key) => {
  const m = new RegExp(`^ {2}${key}:\\n((?: {4}.*\\n?)+)`, 'm').exec(text);
  return m ? m[1] : '';
};

const options = sectionKeys(fs.readFileSync(path.join(ADDON, 'config.yaml'), 'utf8'), 'options');
const languages = fs.readdirSync(TRANSLATIONS).filter((f) => f.endsWith('.yaml'));

test('the add-on ships at least one language and declares options', () => {
  assert.ok(languages.length >= 3, 'en, pl and uk');
  assert.ok(options.length > 20, 'options were parsed');
});

for (const file of languages) {
  test(`${file} translates every option with a name and a description`, () => {
    const text = fs.readFileSync(path.join(TRANSLATIONS, file), 'utf8');
    const translated = sectionKeys(text, 'configuration');
    const missing = options.filter((k) => !translated.includes(k));
    assert.deepEqual(missing, [], `options without a translation in ${file}`);
    const incomplete = options.filter((k) => {
      const body = entry(text, k);
      return !/^ {4}name: \S/m.test(body) || !/^ {4}description: \S/m.test(body);
    });
    assert.deepEqual(incomplete, [], `options missing name or description in ${file}`);
    const stale = translated.filter((k) => !options.includes(k));
    assert.deepEqual(stale, [], `translations for options that no longer exist in ${file}`);
  });
}
