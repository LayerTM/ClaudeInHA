'use strict';

// Tests for the console API router (server/api.js). The file-backed endpoints
// read their paths from CC_OPTIONS_PATH / CC_ALERTS_STATE_PATH, set here BEFORE
// the module is required, so we can drive them with fixtures. No tmux/claude
// binary is needed: status degrades gracefully (claudeVersion → null, tabs → []).
//
// Run with: node --test

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-api-'));
const OPTIONS = path.join(TMP, 'options.json');
const STATE = path.join(TMP, 'alerts-state.json');

process.env.CC_OPTIONS_PATH = OPTIONS;
process.env.CC_ALERTS_STATE_PATH = STATE;
// No Supervisor in the test env: keep /alerts from attempting the HA-states fetch.
delete process.env.SUPERVISOR_TOKEN;

const express = require('express');
const { createRouter } = require('../server/api');

const PORT = 18192;
const BASE = `http://127.0.0.1:${PORT}/api`;
let server;

const writeOptions = (o) => fs.writeFileSync(OPTIONS, JSON.stringify(o));
const writeState = (s) => fs.writeFileSync(STATE, JSON.stringify(s));
const rmFile = (p) => { try { fs.unlinkSync(p); } catch { /* already gone */ } };
const getJson = async (p) => {
  const r = await fetch(`${BASE}${p}`);
  return { status: r.status, body: await r.json() };
};

before(async () => {
  const app = express();
  app.use('/api', createRouter({ uploadDir: TMP }));
  await new Promise((resolve) => { server = app.listen(PORT, resolve); });
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('GET /health → { ok: true }', async () => {
  const { status, body } = await getJson('/health');
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true });
});

test('GET /status surfaces quick_prompts (trimmed, strings-only, capped)', async () => {
  const many = Array.from({ length: 25 }, (_, i) => `prompt ${i}`);
  writeOptions({ quick_prompts: ['  Who is home?  ', '', 42, null, 'Check config', ...many] });
  const { status, body } = await getJson('/status');
  assert.equal(status, 200);
  assert.equal(body.quickPrompts[0], 'Who is home?');
  assert.equal(body.quickPrompts[1], 'Check config');
  assert.ok(!body.quickPrompts.includes(''), 'blank entries dropped');
  assert.equal(body.quickPrompts.length, 20, 'capped at 20');
  assert.ok(Array.isArray(body.tabs));
  assert.equal(body.claudeVersion, null, 'no claude binary in the test env');
});

test('GET /status with unreadable options → empty quickPrompts', async () => {
  rmFile(OPTIONS);
  const { body } = await getJson('/status');
  assert.deepEqual(body.quickPrompts, []);
});

test('GET /alerts reflects options (enabled/interval) and active state', async () => {
  writeOptions({ proactive_alerts: true, proactive_alerts_interval_minutes: 30 });
  writeState({ items: [{ line: 'Water leak — kitchen', critical: true }, { line: 'Battery low' }] });
  const { body } = await getJson('/alerts');
  assert.equal(body.enabled, true);
  assert.equal(body.intervalMinutes, 30);
  assert.equal(body.active.length, 2);
  assert.deepEqual(body.notifications, [], 'no Supervisor → no notifications');
});

test('GET /alerts/summary counts active alerts and flags critical', async () => {
  writeOptions({ proactive_alerts: true });
  writeState({ items: [{ line: 'Leak', critical: true }, { line: 'x' }, { line: 'y' }] });
  const { body } = await getJson('/alerts/summary');
  assert.deepEqual(body, { enabled: true, count: 3, critical: true });
});

test('GET /alerts/summary → count 0, not critical, when no active alerts', async () => {
  writeOptions({ proactive_alerts: false });
  writeState({ items: [] });
  const { body } = await getJson('/alerts/summary');
  assert.deepEqual(body, { enabled: false, count: 0, critical: false });
});

test('GET /alerts/summary tolerates a missing state file', async () => {
  writeOptions({ proactive_alerts: true });
  rmFile(STATE);
  const { body } = await getJson('/alerts/summary');
  assert.deepEqual(body, { enabled: true, count: 0, critical: false });
});
