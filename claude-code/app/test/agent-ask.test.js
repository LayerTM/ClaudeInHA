'use strict';

// agent-ask with a stand-in claude: the answer and the exit status pass through,
// and a failed or stopped call says what it was doing, read from its transcript.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'rootfs', 'usr', 'local', 'bin', 'agent-ask');
const SESSION = '11111111-2222-3333-4444-555555555555';

const STALLED = [
  { type: 'queue-operation' },
  { type: 'api-request' },
  { type: 'api-request' },
  { type: 'system', subtype: 'api_error', error: { message: 'Connection error.' } },
  { type: 'api-request' },
].map((l) => JSON.stringify(l)).join('\n');

function setup(body, transcript) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ask-'));
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  if (transcript !== undefined) {
    const dir = path.join(home, '.claude', 'projects', '-some-dir');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SESSION}.jsonl`), transcript);
  }
  return { home, env: { ...process.env, AGENT_ASK_HOME: home, AGENT_ASK_SESSION_ID: SESSION } };
}

test('a good answer: stdin reaches claude, stdout and exit 0 pass through, stderr stays quiet', () => {
  const { home, env } = setup('printf "args:%s\\n" "$*"; cat', STALLED);
  const r = spawnSync('sh', [SCRIPT], { env, input: 'the prompt', encoding: 'utf8' });
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `args:-p --allowed-tools  --session-id ${SESSION}\nthe prompt`);
  assert.equal(r.stderr, '');
});

test('a failed call keeps its exit status and reports what it did', () => {
  const { home, env } = setup('exit 3', STALLED);
  const r = spawnSync('sh', [SCRIPT], { env, input: '', encoding: 'utf8' });
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /agent-ask: failed \(exit 3\) after \d+ s, session 1111.*: 3 API requests, 0 answers, 1 API errors, last: Connection error\./);
});

test('a call stopped by a time limit leaves the same evidence', { timeout: 15000 }, async () => {
  const { home, env } = setup('trap "exit 143" TERM; echo up; while :; do sleep 0.1; done', STALLED);
  const child = spawn('sh', [SCRIPT], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end('the prompt');
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  // A script that never reaches claude exits instead of printing: don't wait on it.
  await new Promise((resolve) => { child.stdout.once('data', resolve); child.once('exit', resolve); });
  const status = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
    child.kill('SIGTERM');
  });
  fs.rmSync(home, { recursive: true, force: true });
  assert.notEqual(status, 0);
  assert.match(stderr, /agent-ask: stopped after \d+ s, session 1111.*: 3 API requests, 0 answers, 1 API errors, last: Connection error\./);
});

test('no transcript and an unreadable transcript are said, not skipped', () => {
  for (const [transcript, words] of [[undefined, 'no transcript'], ['not json', 'unreadable transcript']]) {
    const { home, env } = setup('exit 1', transcript);
    const r = spawnSync('sh', [SCRIPT], { env, input: '', encoding: 'utf8' });
    fs.rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(words));
  }
});
