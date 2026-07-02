'use strict';

const crypto = require('node:crypto');
const pty = require('node-pty');
const tmux = require('./tmux');

// Pause pty reads when the websocket buffers more than this many bytes.
const BACKPRESSURE_HIGH = 1024 * 1024;
const BACKPRESSURE_CHECK_MS = 50;
const HEARTBEAT_MS = 30000;

const clients = new Set();

// Server-side liveness: browsers answer protocol pings automatically, so a
// client that vanished without TCP FIN is reaped within two heartbeats and
// its view session (which pins the shared window size) dies with it.
setInterval(() => {
  for (const ws of clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* socket already dying */ }
  }
}, HEARTBEAT_MS).unref();

async function broadcastTabs() {
  let tabs;
  try {
    tabs = await tmux.listWindows();
  } catch {
    return;
  }
  const message = JSON.stringify({ t: 'tabs', tabs });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(message);
  }
}

function attach(ws) {
  const view = `view-${crypto.randomUUID().slice(0, 8)}`;
  let term = null;
  let alive = true;
  let drainTimer = null;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  clients.add(ws);

  const start = async () => {
    await tmux.ensureMain();
    if (!alive) return;

    term = pty.spawn('tmux', ['new-session', '-A', '-t', tmux.MAIN, '-s', view], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: tmux.workdir(),
      env: process.env,
    });

    if (!alive) {
      // ws closed while spawning — reap immediately.
      try { term.kill(); } catch { /* already dead */ }
      tmux.killSession(view);
      return;
    }

    // Grouped view sessions die with their client so they never accumulate.
    // The session may not be registered yet when the first attempt runs.
    tmux.setDestroyUnattachedWithRetry(view).catch(() => {});

    let paused = false;
    term.onData((data) => {
      if (!alive || ws.readyState !== ws.OPEN) return;
      ws.send(Buffer.from(data, 'utf8'), { binary: true });
      if (!paused && ws.bufferedAmount > BACKPRESSURE_HIGH) {
        paused = true;
        term.pause();
        drainTimer = setInterval(() => {
          if (!alive || ws.bufferedAmount < BACKPRESSURE_HIGH / 4) {
            clearInterval(drainTimer);
            drainTimer = null;
            paused = false;
            if (alive) { try { term.resume(); } catch { /* exited */ } }
          }
        }, BACKPRESSURE_CHECK_MS);
      }
    });

    term.onExit(() => {
      term = null;
      if (alive && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ t: 'exit' }));
        ws.close();
      }
    });

    await broadcastTabs();
  };

  ws.on('message', (raw, isBinary) => {
    if (!term) return;
    if (isBinary) {
      // Raw bytes from xterm's onBinary path — must not round-trip through
      // UTF-8. latin1 preserves each byte in node-pty's string write.
      try { term.write(raw.toString('latin1')); } catch { /* exited */ }
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      switch (msg.t) {
        case 'in':
          if (typeof msg.d === 'string') term.write(msg.d);
          break;
        case 'resize':
          if (Number.isInteger(msg.cols) && Number.isInteger(msg.rows)
              && msg.cols > 1 && msg.rows > 1 && msg.cols <= 1000 && msg.rows <= 1000) {
            term.resize(msg.cols, msg.rows);
          }
          break;
        case 'select':
          if (Number.isInteger(msg.w) && msg.w >= 0) {
            tmux.selectWindow(view, msg.w).catch(() => {});
          }
          break;
        case 'ping':
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'pong' }));
          break;
        default:
          break;
      }
    } catch {
      // pty died between the null check and the write/resize — the onExit
      // handler is about to close this socket; never let it kill the server.
    }
  });

  const cleanup = () => {
    if (!alive) return;
    alive = false;
    clients.delete(ws);
    if (drainTimer) clearInterval(drainTimer);
    if (term) {
      try { term.kill(); } catch { /* already dead */ }
    }
    tmux.killSession(view);
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);

  start().catch((err) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ t: 'fatal', error: String(err.stderr || err.message || err) }));
      ws.close();
    }
    cleanup();
  });
}

function shutdown() {
  for (const ws of clients) {
    try { ws.terminate(); } catch { /* dying anyway */ }
  }
}

module.exports = { attach, broadcastTabs, shutdown };
