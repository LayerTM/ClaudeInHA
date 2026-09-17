'use strict';

// Claude Code session transcripts and prompt API audit lines for the usage
// golden (agent-usage.test.js). Every date is relative to `now`, so the report
// built from them is the same on any day. usage-claude.golden.json is the
// `ha-usage --json` and `ha-usage --json 3` output of add-on 1.57.2 (before the
// report moved to the core) on exactly these files, without `generated_at`.

const fs = require('node:fs');
const path = require('node:path');

const DAY_MS = 24 * 60 * 60 * 1000;

function iso(now, daysAgo) {
  return new Date(now.getTime() - daysAgo * DAY_MS).toISOString();
}

function auditStamp(now, daysAgo) {
  // The prompt server's own format: `YYYY-MM-DD HH:MM:SS` (UTC here, as the tests run).
  return iso(now, daysAgo).slice(0, 19).replace('T', ' ');
}

function message(now, daysAgo, model, usage) {
  const msg = { role: 'assistant', usage };
  if (model !== undefined) msg.model = model;
  return JSON.stringify({ type: 'assistant', timestamp: iso(now, daysAgo), message: msg });
}

/**
 * Writes HOME/.claude/projects/... and DATA/claude-audit.log.
 * @param {string} home
 * @param {string} data
 * @param {Date} now
 */
function writeUsageData(home, data, now) {
  const projects = path.join(home, '.claude', 'projects');
  const write = (rel, lines) => {
    const file = path.join(projects, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
  };
  const opus = 'claude-opus-5';
  const haiku = 'claude-haiku-4-5';
  write('-homeassistant/one.jsonl', [
    message(now, 0, opus, { input_tokens: 12, output_tokens: 340, cache_read_input_tokens: 5000, cache_creation_input_tokens: 800 }),
    message(now, 0, opus, { input_tokens: 3, output_tokens: 20 }),
    // A count that is not a number counts as 0; the message still counts.
    message(now, 0, opus, { input_tokens: 'many', output_tokens: 7, cache_read_input_tokens: null }),
    // No output_tokens: not a usage record.
    message(now, 0, opus, { input_tokens: 999 }),
    // No model.
    message(now, 0, undefined, { input_tokens: 1, output_tokens: 2 }),
    JSON.stringify({ type: 'user', timestamp: iso(now, 0), message: { role: 'user', content: 'hi' } }),
    '{"usage": broken json',
    JSON.stringify({ timestamp: iso(now, 0), message: 'usage as text' }),
    '',
  ]);
  write('-data-workdir/two.jsonl', [
    message(now, 3, haiku, { input_tokens: 40, output_tokens: 50, cache_read_input_tokens: 60, cache_creation_input_tokens: 70 }),
    message(now, 3, opus, { input_tokens: 1, output_tokens: 1 }),
    // Outside a 7-day window.
    message(now, 10, 'claude-sonnet-5', { input_tokens: 100, output_tokens: 200 }),
    // No timestamp: day "unknown", counted in all_time only.
    JSON.stringify({ message: { model: haiku, usage: { input_tokens: 5, output_tokens: 6 } } }),
    // Zero activity in the window: left out of by_model_recent.
    message(now, 1, 'claude-idle', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 9 }),
  ]);
  // Not a transcript: another extension, and one directory too deep.
  write('-data-workdir/notes.txt', [message(now, 0, opus, { input_tokens: 1000, output_tokens: 1000 })]);
  write('-data-workdir/sub/deep.jsonl', [message(now, 0, opus, { input_tokens: 1000, output_tokens: 1000 })]);

  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'claude-audit.log'), [
    `${auditStamp(now, 0)}  prompt[read] caller=user.a ok tokens=${opus}:4:153:10439:0,${haiku}:903:20:0:0 cost=$0.0123`,
    `${auditStamp(now, 2)}  prompt[write] caller=user.b ok tokens=${haiku}:10:11:12:13 cost=$0.0100`,
    `${auditStamp(now, 20)}  prompt[read] caller=user.c ok cost=$0.5000`,
    // A tool call the audit hook recorded: its numbers are the model's, never spend.
    `${auditStamp(now, 0)}  Bash: echo tokens=${opus}:9999:9999:0:0 cost=$99.0000`,
    '',
  ].join('\n'));
}

module.exports = { writeUsageData };
