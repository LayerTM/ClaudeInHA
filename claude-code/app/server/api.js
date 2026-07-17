'use strict';

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const Busboy = require('busboy');
const tmux = require('./tmux');
const { broadcastTabs } = require('./terminal');

const CLAUDE_BIN = '/data/home/.local/bin/claude';
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GiB hard cap
const MAX_CAPTURE_LINES = 50000;
const MAX_QUICK_PROMPTS = 20;
// Overridable so the API can be unit-tested against fixture files.
const OPTIONS_PATH = process.env.CC_OPTIONS_PATH || '/data/options.json';
const ALERTS_STATE_PATH = process.env.CC_ALERTS_STATE_PATH || '/data/alerts-state.json';

// The user's own quick prompts (add-on option `quick_prompts`), for the 💡 menu.
// Best-effort: unreadable/absent options just yield none, never an error.
async function readQuickPrompts() {
  try {
    const opts = JSON.parse(await fsp.readFile(OPTIONS_PATH, 'utf8'));
    if (!Array.isArray(opts.quick_prompts)) return [];
    return opts.quick_prompts
      .filter((p) => typeof p === 'string' && p.trim())
      .map((p) => p.trim())
      .slice(0, MAX_QUICK_PROMPTS);
  } catch {
    return [];
  }
}

function exec(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000, maxBuffer: 32 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function claudeVersion() {
  try {
    const { stdout } = await exec(CLAUDE_BIN, ['--version'], { env: { ...process.env, HOME: '/data/home' } });
    return stdout.trim().split(/\s+/)[0];
  } catch {
    return null;
  }
}

function sanitizeFilename(name) {
  const base = path.basename(name || 'file').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '_');
  return base.slice(0, 120) || 'file';
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

function createRouter({ uploadDir }) {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  router.get('/health', (req, res) => res.json({ ok: true }));

  router.get('/status', async (req, res) => {
    const [version, tabs, quickPrompts] = await Promise.all([
      claudeVersion(),
      tmux.listWindows().catch(() => []),
      readQuickPrompts(),
    ]);
    res.json({
      claudeVersion: version,
      tabs,
      uploadDir,
      remoteControl: process.env.REMOTE_CONTROL === 'true',
      quickPrompts,
    });
  });

  // Alerts & notifications viewer: the currently-active proactive alerts (from
  // the cc-alerts state file), plus what's sitting in the HA notification bell
  // (where ha-notify posts by default), plus whether proactive alerts are on.
  // Every source is best-effort — a missing file or an unreachable Supervisor
  // just yields empty, never an error.
  router.get('/alerts', async (req, res) => {
    const out = { enabled: false, intervalMinutes: 15, active: [], notifications: [] };
    try {
      const opts = JSON.parse(await fsp.readFile(OPTIONS_PATH, 'utf8'));
      out.enabled = opts.proactive_alerts === true;
      out.intervalMinutes = Number(opts.proactive_alerts_interval_minutes) || 15;
    } catch { /* options unreadable — keep defaults */ }
    try {
      const st = JSON.parse(await fsp.readFile(ALERTS_STATE_PATH, 'utf8'));
      if (Array.isArray(st.items)) out.active = st.items;
    } catch { /* no alert state yet */ }
    try {
      const token = process.env.SUPERVISOR_TOKEN;
      if (token) {
        const r = await fetch('http://supervisor/core/api/states', {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        });
        if (r.ok) {
          const states = await r.json();
          out.notifications = (Array.isArray(states) ? states : [])
            .filter((s) => s && typeof s.entity_id === 'string'
              && s.entity_id.startsWith('persistent_notification.'))
            .map((s) => ({
              title: (s.attributes && s.attributes.title) || '',
              message: (s.attributes && s.attributes.message) || '',
              created: (s.attributes && s.attributes.created_at) || s.last_changed || '',
            }))
            .sort((a, b) => String(b.created).localeCompare(String(a.created)));
        }
      }
    } catch { /* Supervisor unreachable — notifications stay empty */ }
    res.json(out);
  });

  // Lightweight active-alert summary for the toolbar badge — just the count of
  // currently-active alerts and whether any is critical, from the local state
  // file. No Supervisor call, so it is cheap enough to poll every minute.
  router.get('/alerts/summary', async (req, res) => {
    const out = { enabled: false, count: 0, critical: false };
    try {
      const opts = JSON.parse(await fsp.readFile(OPTIONS_PATH, 'utf8'));
      out.enabled = opts.proactive_alerts === true;
    } catch { /* options unreadable — keep defaults */ }
    try {
      const st = JSON.parse(await fsp.readFile(ALERTS_STATE_PATH, 'utf8'));
      if (Array.isArray(st.items)) {
        out.count = st.items.length;
        out.critical = st.items.some((it) => it && it.critical === true);
      }
    } catch { /* no alert state yet */ }
    res.json(out);
  });

  router.get('/capture', async (req, res) => {
    const windowIndex = Number.parseInt(String(req.query.window ?? '0'), 10);
    const lines = Math.min(Number.parseInt(String(req.query.lines ?? '0'), 10) || 0, MAX_CAPTURE_LINES);
    if (!Number.isInteger(windowIndex) || windowIndex < 0) {
      return res.status(400).json({ error: 'invalid window' });
    }
    try {
      const text = await tmux.capturePane(windowIndex, lines);
      res.type('text/plain').send(text.replace(/\s+$/, '\n'));
    } catch (err) {
      res.status(500).json({ error: String(err.stderr || err.message) });
    }
  });

  router.post('/tabs', async (req, res) => {
    try {
      const index = await tmux.newShellWindow();
      await broadcastTabs();
      res.json({ index, tabs: await tmux.listWindows() });
    } catch (err) {
      res.status(500).json({ error: String(err.stderr || err.message) });
    }
  });

  router.delete('/tabs/:index', async (req, res) => {
    const index = Number.parseInt(req.params.index, 10);
    if (!Number.isInteger(index) || index < 0) {
      return res.status(400).json({ error: 'invalid window' });
    }
    try {
      await tmux.killWindow(index);
      await broadcastTabs();
      res.json({ tabs: await tmux.listWindows() });
    } catch (err) {
      res.status(400).json({ error: String(err.stderr || err.message) });
    }
  });

  router.post('/cli/update', async (req, res) => {
    const target = typeof req.body?.target === 'string' ? req.body.target.trim() : '';
    if (target && !/^(?:stable|latest|[0-9][\w.-]*)$/.test(target)) {
      return res.status(400).json({ error: 'invalid target' });
    }
    const before = await claudeVersion();
    let output; // assigned on both the try (success) and catch (failure) paths below
    let failed = false;
    try {
      const args = target ? [target] : [];
      const { stdout, stderr } = await exec('/usr/local/bin/update-claude', args, {
        timeout: 10 * 60 * 1000,
        env: { ...process.env, HOME: '/data/home' },
      });
      output = `${stdout}${stderr}`;
    } catch (err) {
      failed = true;
      output = `${err.stdout || ''}${err.stderr || ''}${err.killed ? '\n[timed out]' : ''}`;
    }
    const after = await claudeVersion();
    res.status(failed ? 500 : 200).json({ before, after, changed: before !== after, output });
  });

  router.post('/claude/respawn', async (req, res) => {
    try {
      await tmux.respawnClaude();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err.stderr || err.message) });
    }
  });

  router.post('/upload', (req, res) => {
    let busboy;
    try {
      busboy = Busboy({ headers: req.headers, limits: { files: 10, fileSize: MAX_UPLOAD_BYTES } });
    } catch (err) {
      return res.status(400).json({ error: String(err.message) });
    }

    const pending = [];
    const active = new Set();
    let aborted = false;

    busboy.on('file', (field, stream, info) => {
      // Random suffix: identical filenames in one request (or same-second
      // requests) must never share a write target.
      const name = `${timestamp()}-${crypto.randomBytes(3).toString('hex')}-${sanitizeFilename(info.filename)}`;
      const target = path.join(uploadDir, name);
      const write = fs.createWriteStream(target, { mode: 0o644 });
      active.add({ stream, write, target });
      const done = new Promise((resolve) => {
        let truncated = false;
        stream.on('limit', () => { truncated = true; });
        stream.pipe(write);
        write.on('close', async () => {
          if (truncated || aborted) {
            await fsp.unlink(target).catch(() => {});
            resolve(null);
          } else {
            const stat = await fsp.stat(target).catch(() => null);
            resolve(stat ? { path: target, name, size: stat.size } : null);
          }
        });
        write.on('error', async () => {
          await fsp.unlink(target).catch(() => {});
          resolve(null);
        });
        stream.on('error', () => write.destroy(new Error('upload stream error')));
      });
      pending.push(done);
    });

    // A client that vanishes mid-upload must not leak fds or partial files.
    req.on('close', async () => {
      if (req.complete) return;
      aborted = true;
      for (const { stream, write, target } of active) {
        stream.unpipe(write);
        write.destroy();
        await fsp.unlink(target).catch(() => {});
      }
    });

    busboy.on('error', () => {
      if (!res.headersSent) res.status(400).json({ error: 'malformed upload' });
      req.unpipe(busboy);
    });

    busboy.on('close', async () => {
      const results = await Promise.all(pending);
      const saved = results.filter(Boolean);
      if (res.headersSent || aborted) return;
      if (!saved.length) return res.status(400).json({ error: 'no files saved (empty or over size limit)' });
      res.json({ files: saved });
    });

    req.pipe(busboy);
  });

  return router;
}

module.exports = { createRouter, claudeVersion };
