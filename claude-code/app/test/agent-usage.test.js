'use strict';

// agent-usage (rootfs/usr/local/bin/agent-usage): Claude Code's console usage
// for the core's ha-usage. The golden is the report the add-on built itself
// before the report moved to the core; on the same transcripts and audit log the
// core's report must say the same, and add only `available` and `error`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeUsageData } = require('./fixtures/usage-claude-data');

const BIN = path.join(__dirname, '..', '..', 'rootfs', 'usr', 'local', 'bin');
const AGENT_USAGE = path.join(BIN, 'agent-usage');
const HA_USAGE = path.join(BIN, 'ha-usage');
const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'usage-claude.golden.json'), 'utf8'));

function withData(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-agent-usage-'));
  try {
    const home = path.join(dir, 'home');
    const data = path.join(dir, 'data');
    writeUsageData(home, data, new Date());
    return fn({ home, data });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the core\'s report on Claude\'s transcripts is the report the add-on built itself', () => {
  withData(({ home, data }) => {
    for (const [args, want] of Object.entries(GOLDEN)) {
      const out = execFileSync('python3', [HA_USAGE, ...args.split(' ')], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, CC_AUDIT_DATA_DIR: data, CC_USAGE_AGENT_CMD: AGENT_USAGE },
      });
      const { generated_at: generatedAt, available, error, ...report } = JSON.parse(out);
      assert.equal(typeof generatedAt, 'string', args);
      assert.equal(available, true, args);
      assert.equal(error, null, args);
      assert.deepEqual(report, { ...want, projects: path.join(home, '.claude', 'projects') }, args);
    }
  });
});

test('one line per assistant message, in the core\'s keys', () => {
  withData(({ home }) => {
    const out = execFileSync(AGENT_USAGE, { encoding: 'utf8', env: { ...process.env, HOME: home } });
    const lines = out.trimEnd().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 9);
    for (const line of lines) {
      assert.deepEqual(Object.keys(line), ['day', 'model', 'input', 'output', 'cache_read', 'cache_write']);
    }
    assert.deepEqual(lines.find((l) => l.model === 'claude-opus-5' && l.output === 340), {
      day: new Date().toISOString().slice(0, 10), model: 'claude-opus-5',
      input: 12, output: 340, cache_read: 5000, cache_write: 800,
    });
    assert.equal(lines.find((l) => l.output === 7).input, 0, 'a count that is not a number is 0');
    assert.equal(lines.filter((l) => l.model === 'unknown').length, 1, 'no model → "unknown"');
    assert.equal(lines.filter((l) => l.day === 'unknown').length, 1, 'no timestamp → "unknown"');
  });
});

test('--source names the transcript directory; anything else is a usage error', () => {
  const home = path.join(os.tmpdir(), 'cc-agent-usage-nowhere');
  const env = { ...process.env, HOME: home };
  assert.equal(execFileSync(AGENT_USAGE, ['--source'], { encoding: 'utf8', env }), `${home}/.claude/projects\n`);
  const bad = spawnSync(AGENT_USAGE, ['--json'], { encoding: 'utf8', env });
  assert.equal(bad.status, 2);
  assert.equal(bad.stdout, '');
  const none = spawnSync(AGENT_USAGE, [], { encoding: 'utf8', env });
  assert.equal(none.status, 0, 'no transcripts yet is usage of nothing, not "not reported"');
  assert.equal(none.stdout, '');
});
