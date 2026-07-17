'use strict';

const crypto = require('node:crypto');
const pty = require('node-pty');
const tmux = require('./tmux');

// Pause pty reads when the websocket buffers more than this many bytes.
const BACKPRESSURE_HIGH = 1024 * 1024;
const BACKPRESSURE_CHECK_MS = 50;
const HEARTBEAT_MS = 30000;

// Claude renders its status line once and caches it, re-running the command only
// slowly. Just after a session opens it may still be launching, or have drawn the
// status line before the terminal reached the browser's width — so nudge a redraw
// at these offsets (ms from connect) to force a re-render at the real width,
// whenever it finishes launching.
const STATUS_REDRAW_DELAYS_MS = [3000, 9000, 20000];
const RESIZE_REDRAW_DEBOUNCE_MS = 500;

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
  // The pty spawns asynchronously (start() awaits tmux). Messages that arrive
  // before it exists must be buffered, not dropped — a dropped initial resize
  // left the pty (and so the tmux window) stuck at the 80x24 spawn size while
  // the client rendered full-width, clipping the terminal to 80 columns.
  let pendingResize = null;
  const pendingInput = [];

  // Debounced status-line redraw: a resize changes the terminal width, but Claude
  // keeps showing its cached (old-width) status line until it re-runs the command.
  // Nudge a redraw once the resize settles.
  let statusRedrawTimer = null;
  const nudgeStatusRedraw = () => {
    if (statusRedrawTimer) clearTimeout(statusRedrawTimer);
    statusRedrawTimer = setTimeout(() => {
      statusRedrawTimer = null;
      if (alive) tmux.redrawClaude().catch(() => {});
    }, RESIZE_REDRAW_DEBOUNCE_MS);
  };

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  clients.add(ws);

  const start = async () => {
    await tmux.ensureMain();
    if (!alive) return;

    term = pty.spawn('tmux', ['new-session', '-A', '-t', tmux.MAIN, '-s', view], {
      name: 'xterm-256color',
      // Spawn at the client's real size when it already told us (during the
      // await above), so the tmux window is correct from birth.
      cols: pendingResize ? pendingResize.cols : 80,
      rows: pendingResize ? pendingResize.rows : 24,
      cwd: tmux.workdir(),
      env: process.env,
    });

    if (!alive) {
      // ws closed while spawning — reap immediately.
      try { term.kill(); } catch { /* already dead */ }
      tmux.killSession(view);
      return;
    }

    // Apply anything that arrived while the pty was still spawning.
    if (pendingResize) {
      try { term.resize(pendingResize.cols, pendingResize.rows); } catch { /* exited */ }
    }
    for (const d of pendingInput) {
      try { term.write(d); } catch { /* exited */ }
    }
    pendingInput.length = 0;

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

    // Force Claude to re-render the status line at the real width once it is up.
    for (const delay of STATUS_REDRAW_DELAYS_MS) {
      setTimeout(() => { if (alive) tmux.redrawClaude().catch(() => {}); }, delay).unref();
    }
  };

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      // Raw bytes from xterm's onBinary path — must not round-trip through
      // UTF-8. latin1 preserves each byte in node-pty's string write.
      const data = raw.toString('latin1');
      if (term) { try { term.write(data); } catch { /* exited */ } }
      else pendingInput.push(data);
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
          if (typeof msg.d === 'string') {
            if (term) term.write(msg.d);
            else pendingInput.push(msg.d);
          }
          break;
        case 'resize':
          if (Number.isInteger(msg.cols) && Number.isInteger(msg.rows)
              && msg.cols > 1 && msg.rows > 1 && msg.cols <= 1000 && msg.rows <= 1000) {
            // Remember the latest size even before the pty exists, so start()
            // can spawn/resize to it instead of dropping it.
            pendingResize = { cols: msg.cols, rows: msg.rows };
            if (term) { term.resize(msg.cols, msg.rows); nudgeStatusRedraw(); }
          }
          break;
        case 'select':
          if (term && Number.isInteger(msg.w) && msg.w >= 0) {
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
      // pty died mid-handling — the onExit handler is about to close this
      // socket; never let it kill the server.
    }
  });

  const cleanup = () => {
    if (!alive) return;
    alive = false;
    clients.delete(ws);
    if (drainTimer) clearInterval(drainTimer);
    if (statusRedrawTimer) clearTimeout(statusRedrawTimer);
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
