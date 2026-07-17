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

// Serialized: concurrent first connections must not both run new-session.
let ensureMainInFlight = null;
function ensureMain() {
  if (!ensureMainInFlight) {
    ensureMainInFlight = (async () => {
      if (await hasSession(MAIN)) return;
      try {
        await run(['new-session', '-d', '-s', MAIN, '-n', 'claude', '-c', workdir(), '/usr/local/bin/start-claude']);
      } catch (err) {
        if (!/duplicate session/.test(String(err.stderr || ''))) throw err;
      }
    })().finally(() => { ensureMainInFlight = null; });
  }
  return ensureMainInFlight;
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

// Force Claude to re-run its statusLine command by sending a redraw (Ctrl+L) to
// the Claude window. Claude renders the status line once and caches it,
// refreshing only slowly — so if it drew it before the terminal reached the
// browser's width, the bottom bar stays truncated. A redraw makes Claude
// re-render at the current width. Harmless: Ctrl+L only repaints; it preserves
// the input line and scrollback.
async function redrawClaude() {
  await run(['send-keys', '-t', `${MAIN}:${CLAUDE_WINDOW}`, 'C-l']);
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
  await run(['set-option', '-t', `=${session}`, 'destroy-unattached', 'on']);
}

// The grouped session is registered by the pty's tmux client slightly after
// spawn; retry briefly instead of racing it.
async function setDestroyUnattachedWithRetry(session, attempts = 10, delayMs = 100) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await setDestroyUnattached(session);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
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
  redrawClaude,
  capturePane,
  selectWindow,
  killSession,
  setDestroyUnattached,
  setDestroyUnattachedWithRetry,
  ensureWindow,
};
