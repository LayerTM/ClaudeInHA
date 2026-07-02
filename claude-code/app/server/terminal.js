'use strict';

const crypto = require('node:crypto');
const pty = require('node-pty');
const tmux = require('./tmux');

// Pause pty reads when the websocket buffers more than this many bytes.
const BACKPRESSURE_HIGH = 1024 * 1024;
const BACKPRESSURE_CHECK_MS = 50;

const clients = new Set();

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

  clients.add(ws);

  const start = async () => {
    await tmux.ensureMain();
    term = pty.spawn('tmux', ['new-session', '-A', '-t', tmux.MAIN, '-s', view], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: tmux.workdir(),
      env: process.env,
    });

    // Grouped view sessions die with their client so they never accumulate.
    tmux.setDestroyUnattached(view).catch(() => {});

    let paused = false;
    term.onData((data) => {
      if (!alive || ws.readyState !== ws.OPEN) return;
      ws.send(Buffer.from(data, 'utf8'), { binary: true });
      if (!paused && ws.bufferedAmount > BACKPRESSURE_HIGH) {
        paused = true;
        term.pause();
        const drain = setInterval(() => {
          if (!alive || ws.bufferedAmount < BACKPRESSURE_HIGH / 4) {
            clearInterval(drain);
            paused = false;
            if (alive) term.resume();
          }
        }, BACKPRESSURE_CHECK_MS);
      }
    });

    term.onExit(() => {
      if (alive && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ t: 'exit' }));
        ws.close();
      }
    });

    await broadcastTabs();
  };

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.t) {
      case 'in':
        if (term && typeof msg.d === 'string') term.write(msg.d);
        break;
      case 'resize':
        if (term && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)
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
  });

  const cleanup = () => {
    if (!alive) return;
    alive = false;
    clients.delete(ws);
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

module.exports = { attach, broadcastTabs };
