'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');

const MAIN = 'main';
const CLAUDE_WINDOW = '0';

function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: 15000, maxBuffer: 32 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

function workdir() {
  try {
    fs.accessSync('/homeassistant', fs.constants.W_OK);
    return '/homeassistant';
  } catch {
    return '/data/workdir';
  }
}

async function hasSession(name) {
  try {
    await run(['has-session', '-t', `=${name}`]);
    return true;
  } catch {
    return false;
  }
}

async function ensureMain() {
  if (await hasSession(MAIN)) return;
  await run(['new-session', '-d', '-s', MAIN, '-n', 'claude', '-c', workdir(), '/usr/local/bin/start-claude']);
}

async function listWindows() {
  const out = await run(['list-windows', '-t', MAIN, '-F', '#{window_index}\t#{window_name}']);
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [index, name] = line.split('\t');
      return { index: Number(index), name };
    });
}

async function newShellWindow() {
  const out = await run([
    'new-window', '-d', '-t', MAIN, '-n', 'shell', '-c', workdir(),
    '-P', '-F', '#{window_index}',
    'bash', '-l',
  ]);
  return Number(out.trim());
}

async function killWindow(index) {
  if (String(index) === CLAUDE_WINDOW) {
    throw new Error('The Claude window cannot be closed');
  }
  await run(['kill-window', '-t', `${MAIN}:${index}`]);
}

async function respawnClaude() {
  await run(['respawn-window', '-k', '-t', `${MAIN}:${CLAUDE_WINDOW}`, '/usr/local/bin/start-claude']);
}

async function capturePane(index, lines) {
  const args = ['capture-pane', '-p', '-J', '-t', `${MAIN}:${index}`];
  if (lines > 0) args.push('-S', `-${lines}`);
  return run(args);
}

async function selectWindow(session, index) {
  await run(['select-window', '-t', `${session}:${index}`]);
}

async function killSession(name) {
  try {
    await run(['kill-session', '-t', `=${name}`]);
  } catch {
    /* already gone */
  }
}

async function setDestroyUnattached(session) {
  await run(['set-option', '-t', session, 'destroy-unattached', 'on']);
}

async function ensureWindow(name, command) {
  const windows = await listWindows();
  const existing = windows.find((w) => w.name === name);
  if (existing) return existing.index;
  const out = await run([
    'new-window', '-d', '-t', MAIN, '-n', name, '-c', workdir(),
    '-P', '-F', '#{window_index}',
    ...command,
  ]);
  return Number(out.trim());
}

module.exports = {
  MAIN,
  CLAUDE_WINDOW,
  workdir,
  ensureMain,
  listWindows,
  newShellWindow,
  killWindow,
  respawnClaude,
  capturePane,
  selectWindow,
  killSession,
  setDestroyUnattached,
  ensureWindow,
};
