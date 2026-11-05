'use strict';

// engine_auth asks for a login only when none exists. The console login lives in
// the credentials file, not in the add-on options, so empty options alone must
// not produce the notice on an install that is signed in.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOKS = path.join(__dirname, '..', '..', 'rootfs', 'usr', 'local', 'lib', 'engine-hooks.sh');

// A stand-in bashio: options come from the environment, log lines go to stdout.
const BASHIO = `
bashio::config() { case "$1" in api_key) printf '%s' "$STUB_OPTION_ONE" ;; oauth_token) printf '%s' "$STUB_OPTION_TWO" ;; esac; }
bashio::var.has_value() { [ -n "$1" ]; }
bashio::log.info() { echo "INFO $*"; }
bashio::log.notice() { echo "NOTICE $*"; }
`;

function run({ apiKey = '', oauth = '', loggedIn = false }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-notice-'));
  try {
    if (loggedIn) {
      fs.mkdirSync(path.join(home, '.claude'));
      fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}');
    }
    const fn = fs.readFileSync(HOOKS, 'utf8').match(/^engine_auth\(\) \{[\s\S]*?^\}/m)[0];
    return spawnSync('bash', ['-c', `${BASHIO}\n${fn}\nengine_auth`], {
      env: { ...process.env, HOME: home, STUB_OPTION_ONE: apiKey, STUB_OPTION_TWO: oauth },
      encoding: 'utf8',
    }).stdout;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('no option and no console login: the notice asks for a login', () => {
  assert.match(run({}), /NOTICE No api_key or oauth_token set/);
});

test('no option but a console login: no notice', () => {
  assert.doesNotMatch(run({ loggedIn: true }), /NOTICE/);
});

test('a token option: no notice', () => {
  assert.doesNotMatch(run({ oauth: 'x' }), /NOTICE/);
  assert.doesNotMatch(run({ apiKey: 'x' }), /NOTICE/);
});
