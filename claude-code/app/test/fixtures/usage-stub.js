#!/usr/bin/env node
'use strict';

// Stand-in for `ha-usage --json` used by the prompt-server tests: emits a
// fixed, contract-shaped usage report (or fails when asked, to test 503).

if (process.argv.includes('--fail')) process.exit(1);

process.stdout.write(`${JSON.stringify({
  projects: '/data/home/.claude/projects',
  window_days: 7,
  tokens: {
    today: { input: 1, output: 2, cache_read: 3, cache_write: 4 },
    recent: { input: 5, output: 6, cache_read: 7, cache_write: 8 },
    all_time: { input: 9, output: 10, cache_read: 11, cache_write: 12 },
  },
  by_model_recent: { 'claude-opus-4-8': { input: 5, output: 6, cache_read: 7, cache_write: 8 } },
  messages: { today: 1, recent: 2, all_time: 3 },
  prompt_api_cost_usd: { today: 0.12, total: 3.45 },
  generated_at: '2026-07-03T00:00:00Z',
})}\n`);
