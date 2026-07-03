'use strict';

// HTTP layer of the prompt server. Middleware order is the security design
// (research §3): IP guard → bearer auth → body caps/schema → rate limit →
// concurrency semaphore → run Claude → output cap + redaction → audit.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const express = require('express');
const {
  ipAllowed, tokenMatches, sanitizePrompt, sanitizeId,
  validateIntents, redactDeep, sha12,
} = require('./security');
const { runClaude } = require('./runner');

const MAX_PROMPT_BYTES = 8 * 1024;
const MAX_CONCURRENT_RUNS = 2;
const BODY_KEYS = new Set(['prompt', 'mode', 'conversation_id', 'intents']);

// Token bucket. Refill is computed lazily on take().
class Bucket {
  constructor(capacity, refillPerSec) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.stamp = Date.now();
  }

  take() {
    const now = Date.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.stamp) / 1000) * this.refillPerSec,
    );
    this.stamp = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - this.tokens) / this.refillPerSec);
  }
}

// Hard ceiling on distinct per-caller buckets. X-Claude-Caller is
// client-controlled, so without a cap a flood of unique caller ids would grow
// the Map without bound and OOM the (shared) process. Well above any real
// caller count; when exceeded we evict the least-recently-used entries.
const MAX_CALLERS = 4096;

function createRateLimiter() {
  // Rate limits guard against a runaway automation; the concurrency semaphore
  // (MAX_CONCURRENT_RUNS) is the hard DoS control. Keep these loose enough for
  // interactive Assist use: global ~30/min (burst 20), per-caller ~12/min
  // (burst 6). A caller over its own budget is rejected before the global
  // bucket is touched, so it cannot starve other callers.
  const globalBucket = new Bucket(20, 0.5);
  const perCaller = new Map(); // caller -> {bucket, lastUsed} (insertion ~ LRU)

  setInterval(() => {
    const cutoff = Date.now() - 3600 * 1000;
    for (const [key, entry] of perCaller) {
      if (entry.lastUsed < cutoff) perCaller.delete(key);
    }
  }, 10 * 60 * 1000).unref();

  return (caller) => {
    let entry = perCaller.get(caller);
    if (entry) {
      // Refresh LRU position: delete + re-set moves it to the newest slot.
      perCaller.delete(caller);
    } else {
      // Evict the oldest entries (Map preserves insertion order) until there
      // is room. Bounds memory regardless of how many unique callers appear.
      while (perCaller.size >= MAX_CALLERS) {
        const oldest = perCaller.keys().next().value;
        if (oldest === undefined) break;
        perCaller.delete(oldest);
      }
      entry = { bucket: new Bucket(3, 0.1), lastUsed: 0 }; // burst 3, ~6/min
    }
    entry.lastUsed = Date.now();
    perCaller.set(caller, entry);
    const waitCaller = entry.bucket.take();
    if (waitCaller > 0) return waitCaller;
    const waitGlobal = globalBucket.take();
    if (waitGlobal > 0) return waitGlobal;
    return 0;
  };
}

function createPromptApp({
  token, claudeBin, usageBin, mcpConfigPath, model, workDir, addonVersion, redact, audit,
}) {
  const app = express();
  app.disable('x-powered-by');

  let activeRuns = 0;

  // Cached `claude --version` (refreshed lazily, at most every 5 minutes).
  // A single in-flight refresh is shared by all concurrent callers, so a burst
  // of /api/status requests forks at most ONE `claude` process, not one each.
  let versionCache = { value: null, stamp: 0 };
  let versionInFlight = null;
  function claudeVersion() {
    if (Date.now() - versionCache.stamp < 5 * 60 * 1000) {
      return Promise.resolve(versionCache.value);
    }
    if (versionInFlight) return versionInFlight;
    versionInFlight = new Promise((resolve) => {
      execFile(claudeBin, ['--version'], {
        timeout: 15000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      }, (err, stdout) => {
        const value = err ? null : String(stdout).trim().split(/\s+/)[0] || null;
        versionCache = { value, stamp: Date.now() };
        versionInFlight = null;
        resolve(value);
      });
    });
    return versionInFlight;
  }

  // Cached usage report from `ha-usage --json`. Parsing the CLI transcripts is
  // heavy, so cache for a few minutes and share one in-flight run across callers
  // (the coordinator sensor should poll no more than every few minutes).
  let usageCache = { value: null, stamp: 0 };
  let usageInFlight = null;
  function usageReport() {
    if (usageCache.value && Date.now() - usageCache.stamp < 3 * 60 * 1000) {
      return Promise.resolve(usageCache.value);
    }
    if (usageInFlight) return usageInFlight;
    usageInFlight = new Promise((resolve) => {
      execFile(usageBin, ['--json'], {
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      }, (err, stdout) => {
        usageInFlight = null;
        if (err) { resolve(null); return; }
        try {
          const parsed = JSON.parse(String(stdout));
          usageCache = { value: parsed, stamp: Date.now() };
          resolve(parsed);
        } catch {
          resolve(null);
        }
      });
    });
    return usageInFlight;
  }

  // 1. IP guard — the internal Supervisor network plus loopback only.
  app.use((req, res, next) => {
    if (!ipAllowed(req.socket.remoteAddress)) {
      audit(`prompt[deny] reason=403 ip=${sanitizeId(String(req.socket.remoteAddress), 48)}`);
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  });

  // 2. Bearer auth — constant-time compare, before any body parsing.
  app.use((req, res, next) => {
    const header = req.get('authorization') || '';
    const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!tokenMatches(presented, token)) {
      audit(`prompt[deny] reason=401 ip=${sanitizeId(String(req.socket.remoteAddress), 48)} path=${sanitizeId(req.path, 32)}`);
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  });

  app.get('/api/status', async (req, res) => {
    const version = await claudeVersion();
    const home = process.env.HOME || '/data/home';
    const authConfigured = Boolean(
      process.env.ANTHROPIC_API_KEY
      || process.env.CLAUDE_CODE_OAUTH_TOKEN
      || fs.existsSync(`${home}/.claude/.credentials.json`),
    );
    res.json({
      ready: Boolean(version) && authConfigured,
      version: addonVersion,
      claude_version: version || '',
      model: model || '',
      ha_mcp: Boolean(mcpConfigPath),
    });
  });

  // Token usage + prompt-API cost, for the integration's usage sensor.
  app.get('/api/usage', async (req, res) => {
    const report = await usageReport();
    if (!report) return res.status(503).json({ error: 'usage unavailable' });
    // Usage is numbers + model names, but redact defensively for consistency.
    res.json(redactDeep(report, redact));
  });

  const rateLimit = createRateLimiter();

  app.post(
    '/api/prompt',
    express.json({ limit: '64kb', strict: true }),
    async (req, res) => {
      const caller = sanitizeId(req.get('x-claude-caller'), 64) || 'anonymous';
      const body = req.body;

      // 3. Input schema + caps.
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return res.status(400).json({ error: 'body must be a JSON object' });
      }
      for (const key of Object.keys(body)) {
        if (!BODY_KEYS.has(key)) {
          return res.status(400).json({ error: `unknown field: ${sanitizeId(key, 32)}` });
        }
      }
      const mode = body.mode === undefined ? 'read' : body.mode;
      if (mode !== 'read' && mode !== 'write') {
        return res.status(400).json({ error: 'mode must be "read" or "write"' });
      }
      // In read mode the prompt IS the request. In write mode it is optional and
      // audit-only — execution is driven solely by the validated intents and the
      // prompt is NEVER shown to the model (no untrusted input on the write path).
      if (mode === 'read') {
        if (typeof body.prompt !== 'string' || body.prompt.trim().length === 0) {
          return res.status(400).json({ error: 'prompt must be a non-empty string' });
        }
      } else if (body.prompt !== undefined && typeof body.prompt !== 'string') {
        return res.status(400).json({ error: 'prompt must be a string' });
      }
      if (typeof body.prompt === 'string' && Buffer.byteLength(body.prompt, 'utf8') > MAX_PROMPT_BYTES) {
        audit(`prompt[deny] reason=413 caller=${caller}`);
        return res.status(413).json({ error: 'prompt too large (max 8 KB)' });
      }
      if (body.conversation_id !== undefined && typeof body.conversation_id !== 'string') {
        return res.status(400).json({ error: 'conversation_id must be a string' });
      }
      const conversationId = sanitizeId(body.conversation_id, 128);

      let intents = null;
      if (mode === 'write') {
        const checked = validateIntents(body.intents);
        if (!checked.ok) {
          audit(`prompt[deny] reason=400 caller=${caller} detail=${sanitizeId(checked.error, 64)}`);
          return res.status(400).json({ error: checked.error });
        }
        intents = checked.intents;
        if (!mcpConfigPath) {
          audit(`prompt[deny] reason=503-no-mcp caller=${caller}`);
          return res.status(503).json({ error: 'write mode unavailable: no HA MCP configured (set an HA token in the add-on options)' });
        }
      } else if (body.intents !== undefined) {
        return res.status(400).json({ error: 'intents is only valid with mode "write"' });
      }

      const prompt = typeof body.prompt === 'string' ? sanitizePrompt(body.prompt) : '';

      // 4. Rate limit (per caller, then global).
      const retryAfter = rateLimit(caller);
      if (retryAfter > 0) {
        audit(`prompt[deny] reason=429 caller=${caller}`);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ error: 'rate limited' });
      }

      // 5. Concurrency semaphore.
      if (activeRuns >= MAX_CONCURRENT_RUNS) {
        audit(`prompt[deny] reason=503-busy caller=${caller}`);
        return res.status(503).json({ error: 'busy' });
      }
      activeRuns += 1;

      const started = Date.now();
      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) abort.abort();
      });

      let outcome;
      try {
        // 6. Run Claude (stateless, scrubbed, deny-by-default).
        outcome = await runClaude({
          bin: claudeBin,
          prompt,
          mode,
          intents: intents || [],
          mcpConfigPath,
          model,
          cwd: workDir,
          signal: abort.signal,
        });
      } finally {
        activeRuns -= 1;
      }

      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      // Audit the confirmed intents/targets for write, the prompt hash for read.
      const detail = mode === 'write'
        ? `intents=${intents.map((i) => `${i.intent}(${i.targets.join('+')})`).join(',')}`
        : `len=${Buffer.byteLength(prompt, 'utf8')} sha=${sha12(prompt)}`;
      const base = `caller=${caller}${conversationId ? ` conv=${conversationId}` : ''} ${detail}`;

      if (outcome.status === 'timeout') {
        audit(`prompt[${mode}] ${base} status=504 dur=${seconds}s`);
        return res.status(504).json({ error: 'timeout' });
      }
      if (outcome.status !== 'ok') {
        audit(`prompt[${mode}] ${base} status=500 dur=${seconds}s`);
        console.error(`[prompt] run failed (${caller}): ${redact(outcome.message || 'unknown')}`);
        return res.status(500).json({ error: 'internal error' });
      }

      // 7. Output: redact secrets from EVERY model-shaped field before it
      // leaves the add-on — text, the whole proposal (summary + each intent's
      // free-form data), and the tool names.
      const text = redact(outcome.text);
      const proposal = outcome.proposal ? redactDeep(outcome.proposal, redact) : null;
      const toolsUsed = outcome.toolsUsed.map((t) => redact(t));

      const cost = outcome.costUsd == null ? '' : ` cost=$${Number(outcome.costUsd).toFixed(4)}`;
      audit(
        `prompt[${mode}] ${base} status=200 dur=${seconds}s turns=${outcome.numTurns ?? '?'}`
        + ` tools=${outcome.toolsUsed.map((t) => sanitizeId(t, 64)).join('|') || '-'}`
        + ` out=${Buffer.byteLength(text, 'utf8')}B${outcome.truncated ? ' truncated' : ''}`
        + `${outcome.mcpFailed ? ' mcp=FAILED' : ''}${proposal ? ' proposal=yes' : ''}${cost}`,
      );
      if (outcome.mcpFailed) {
        console.error('[prompt] HA MCP server did not connect — check the HA token and that the Model Context Protocol Server integration is installed');
      }

      res.json({
        text,
        proposal,
        tools_used: toolsUsed,
        truncated: outcome.truncated,
      });
    },
  );

  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  // Express error funnel: body-parser errors and anything a handler throws.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return;
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'body too large' });
    }
    if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
      return res.status(400).json({ error: 'invalid JSON body' });
    }
    console.error('[prompt] handler error:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

module.exports = { createPromptApp, createRateLimiter, Bucket };
