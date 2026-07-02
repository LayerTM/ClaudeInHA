'use strict';

const http = require('node:http');
const path = require('node:path');
const fsp = require('node:fs/promises');
const express = require('express');
const { WebSocketServer } = require('ws');
const tmux = require('./tmux');
const { createRouter } = require('./api');
const terminal = require('./terminal');

const PORT = Number(process.env.CLAUDE_CONSOLE_PORT || 8099);
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/uploads';
const RETENTION_DAYS = Number(process.env.UPLOAD_RETENTION_DAYS || 14);
const DEV = process.env.CLAUDE_CONSOLE_DEV === '1';

// Ingress requests arrive exclusively from the Supervisor gateway; loopback
// is allowed for the add-on watchdog and in-container tooling.
const ALLOWED_SOURCES = new Set([
  '172.30.32.2', '::ffff:172.30.32.2',
  '127.0.0.1', '::1', '::ffff:127.0.0.1',
]);

function sourceAllowed(socket) {
  return DEV || ALLOWED_SOURCES.has(socket.remoteAddress);
}

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  if (!sourceAllowed(req.socket)) return res.status(403).send('Forbidden');
  next();
});

// Frontend
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: '1h' }));

// Vendor assets served straight from installed packages
const VENDOR = {
  '/vendor/xterm.js': '@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css': '@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
  '/vendor/addon-unicode11.js': '@xterm/addon-unicode11/lib/addon-unicode11.js',
  '/vendor/addon-web-links.js': '@xterm/addon-web-links/lib/addon-web-links.js',
  '/vendor/addon-webgl.js': '@xterm/addon-webgl/lib/addon-webgl.js',
};
for (const [route, mod] of Object.entries(VENDOR)) {
  const file = require.resolve(mod);
  app.get(route, (req, res) => res.sendFile(file, { maxAge: '1d' }));
}

app.use('/api', createRouter({ uploadDir: UPLOAD_DIR }));

const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws' || !sourceAllowed(socket)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => terminal.attach(ws));
});

async function cleanupUploads() {
  if (!(RETENTION_DAYS > 0)) return;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  let entries;
  try {
    entries = await fsp.readdir(UPLOAD_DIR);
  } catch {
    return;
  }
  for (const name of entries) {
    const file = path.join(UPLOAD_DIR, name);
    try {
      const stat = await fsp.stat(file);
      if (stat.isFile() && stat.mtimeMs < cutoff) await fsp.unlink(file);
    } catch {
      /* removed concurrently */
    }
  }
}

async function main() {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  await tmux.ensureMain();

  if (process.env.REMOTE_CONTROL === 'true') {
    // Official Anthropic Remote Control: runs in its own tab so the session
    // URL and QR code render in a real terminal. Requires a full-scope /login.
    tmux.ensureWindow('remote', ['claude', 'remote-control']).catch((err) => {
      console.error('remote-control window failed:', err.stderr || err.message);
    });
  }

  cleanupUploads();
  setInterval(cleanupUploads, 6 * 3600 * 1000).unref();

  server.listen(PORT, () => {
    console.log(`Claude Console listening on :${PORT}`);
  });
}

process.on('SIGTERM', () => server.close(() => process.exit(0)));

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
