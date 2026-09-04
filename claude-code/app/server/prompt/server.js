'use strict';

// HTTP layer of the prompt server. Middleware order is the security design
// (research §3): IP guard → bearer auth → body caps/schema → rate limit →
// concurrency semaphore → run Claude → output cap + redaction → audit.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const {
  ipAllowed, tokenMatches, sanitizePrompt, sanitizeId,
  validateIntents, redactDeep, sha12,
} = require('./security');
const { runClaude, TIMEOUT_MS, safeLangTag } = require('./runner');
const { createHistoryStore } = require('./history');

const MAX_PROMPT_BYTES = 8 * 1024;
const MAX_CONCURRENT_RUNS = 2;
const BODY_KEYS = new Set([
  'prompt', 'mode', 'conversation_id', 'intents', 'confirmation', 'image_entity', 'stream', 'language',
  'surface', 'edit_automation',
]);

// When streaming, hold back this many trailing chars of the redacted text before
// emitting, so a secret split across fragments is redacted before any of it ships.
// The terminal `done` line always carries the fully-redacted authoritative text.
const STREAM_SAFETY_WINDOW = 96;

// Camera vision: only a well-formed `camera.<object_id>` may be snapshotted, the
// image is capped, and the integration must only pass cameras exposed to Assist.
const CAMERA_ENTITY_RE = /^camera\.[a-z0-9_]{1,120}$/;
const SNAPSHOT_CAP_BYTES = 8 * 1024 * 1024;

// Boundary backstop for unconfirmed (`confirmation:"auto"`) writes. The
// integration does the fine-grained, metadata-aware risk classification (it has
// the HA registry: device_class, entity_category, integration). This coarse
// domain denylist is defense-in-depth AT THE SECURITY BOUNDARY: these domains
// are inherently high-consequence, so an auto write is NEVER allowed to touch
// them no matter what the caller or the model claimed. Confirmed writes are
// unaffected. From an entity id only the domain (prefix before ".") is knowable
// here, so this is intentionally coarse — the real gate is upstream.
const CRITICAL_NEVER_AUTO = new Set([
  'lock', 'cover', 'alarm_control_panel', 'valve', 'water_heater',
  'lawn_mower', 'update', 'siren', 'garage_door',
]);

// Resilience: a chat read that dies to a transient API/generation failure is
// the single worst UX (the whole answer just vanishes). These reasons are
// transient — the identical prompt commonly succeeds on a second run — so a read
// is retried once before we give up, and even then it DEGRADES to a friendly 200
// message instead of a bare 500 so the conversation never simply dies. Writes are
// never retried or degraded: a state-changing action must fail honestly.
// `tool-name-mismatch` is raised at init — BEFORE any tool has run — and the
// outcome carries the tool names HA really publishes, so the retry runs with a
// corrected allowlist rather than repeating the same doomed call.
const RETRYABLE_REASONS = new Set(['no-result', 'model-error', 'tool-name-mismatch']);
// Total attempts per read (1 = no retry). Bounded to keep worst-case latency sane.
const MAX_ATTEMPTS = Math.min(3, Math.max(1, Number(process.env.CLAUDE_PROMPT_MAX_ATTEMPTS) || 2));
// Backoff between attempts; small, since each attempt already carries its own
// wall-clock cost. Tunable (and driven low by the test suite).
const RETRY_BACKOFF_MS = Math.min(5000, Math.max(0, Number(process.env.CLAUDE_PROMPT_RETRY_BACKOFF_MS) || 300));
// A retry only fires if at least this much of the one-request budget remains — so
// the TOTAL wall-clock across attempts stays within a single TIMEOUT_MS (the retry
// gets the REMAINING budget, not a fresh one) and a nearly-spent read degrades now
// instead of running a pointless second time. Tunable (low in tests).
const MIN_RETRY_BUDGET_MS = Math.min(TIMEOUT_MS, Math.max(1000, Number(process.env.CLAUDE_PROMPT_MIN_RETRY_BUDGET_MS) || 15000));
// The few user-facing strings the SERVER authors (the model otherwise answers in
// the user's own language). Localized to the request `language` — the integration
// forwards the HA conversation language, e.g. "uk" / "en" / "pl-PL". An absent or
// unsupported language falls back to English. The English degrade wording keeps
// "couldn't finish" / "try again" — callers and tests key off it.
const DEGRADE_TEXT = {
  en: "Sorry — I couldn't finish that response. Please try again.",
  uk: 'Вибач — не вдалося завершити відповідь. Спробуй ще раз.',
  pl: 'Przepraszam — nie udało się dokończyć odpowiedzi. Spróbuj ponownie.',
  de: 'Entschuldigung — ich konnte diese Antwort nicht abschließen. Bitte versuche es noch einmal.',
  fr: "Désolé — je n'ai pas pu terminer cette réponse. Réessaie, s'il te plaît.",
  es: 'Lo siento — no pude terminar esa respuesta. Inténtalo de nuevo, por favor.',
  it: 'Scusa — non sono riuscito a completare la risposta. Riprova, per favore.',
  pt: 'Desculpa — não consegui terminar essa resposta. Tenta novamente, por favor.',
  nl: 'Sorry — ik kon dat antwoord niet afmaken. Probeer het opnieuw.',
};
// Derived from the notice table so the supported set can never drift from the
// strings: adding a language = adding it to DEGRADE_TEXT + budgetNotice only.
const SUPPORTED_LANGS = new Set(Object.keys(DEGRADE_TEXT));
function langOf(raw) {
  const code = String(raw || '').slice(0, 2).toLowerCase();
  return SUPPORTED_LANGS.has(code) ? code : 'en';
}
const budgetNotice = (lang, limit) => ({
  en: `I've reached today's Claude usage budget ($${limit}), so I'm paused until tomorrow. You can raise "Chat daily budget (USD)" in the add-on options.`,
  uk: `Досягнуто денного бюджету Claude ($${limit}) — я на паузі до завтра. Збільшити його можна в опції додатка «Chat daily budget (USD)».`,
  pl: `Osiągnięto dzienny budżet Claude ($${limit}) — jestem wstrzymany do jutra. Możesz go zwiększyć w opcji dodatku „Chat daily budget (USD)”.`,
  de: `Ich habe das heutige Claude-Nutzungsbudget ($${limit}) erreicht und pausiere bis morgen. Du kannst „Chat daily budget (USD)" in den Add-on-Optionen erhöhen.`,
  fr: `J'ai atteint le budget d'utilisation Claude d'aujourd'hui ($${limit}), je suis donc en pause jusqu'à demain. Tu peux augmenter « Chat daily budget (USD) » dans les options du module.`,
  es: `He alcanzado el presupuesto de uso de Claude de hoy ($${limit}), así que estoy en pausa hasta mañana. Puedes aumentar "Chat daily budget (USD)" en las opciones del add-on.`,
  it: `Ho raggiunto il budget d'uso di Claude di oggi ($${limit}), quindi sono in pausa fino a domani. Puoi aumentare "Chat daily budget (USD)" nelle opzioni dell'add-on.`,
  pt: `Atingi o orçamento de uso do Claude de hoje ($${limit}), por isso estou pausado até amanhã. Podes aumentar "Chat daily budget (USD)" nas opções do add-on.`,
  nl: `Ik heb het Claude-gebruiksbudget van vandaag ($${limit}) bereikt en pauzeer tot morgen. Je kunt "Chat daily budget (USD)" in de add-on-opties verhogen.`,
}[lang]);
const delay = (ms) => new Promise((r) => { setTimeout(r, ms); });

// Rolling summary of recent chat READ runs, surfaced on /api/status so the
// integration can show a soft health signal ("chat degraded N of the last M").
// In-memory ring (last `cap`); a failure carries only a reason TOKEN from the
// runner's reason enum — NEVER prompt content. `recovered` counts reads that a
// retry rescued (a transient blip the user never saw).
function createChatHealth(cap = 50, persist = null, now = Date.now) {
  // Optionally seed from a durable store so the rolling window survives an
  // add-on restart. A malformed/absent store reads as an empty history.
  //
  // `ts` is preserved rather than rebuilt: the window is trimmed by COUNT, so on
  // an install where Assist is used a few times a day the last 50 runs span
  // weeks, and a single transient failure would otherwise sit in the published
  // summary indefinitely with nothing to say how old it is. An entry written by
  // an older build has no `ts`; that reads as null — unknown, and therefore old.
  //
  // A persisted entry is trusted only as far as it can be read. Anything that is
  // not an object is not a run and is dropped, never coerced: coercion turns a
  // junk element into a FABRICATED failure with an unknown time, which is exactly
  // the shape the consumer treats most conservatively — it would hold the sensor
  // red until 50 real chats pushed it out. And a `ts` is a positive whole count
  // of milliseconds or it is unknown, so the published field means what its name
  // says rather than relying on every consumer to sanitise it.
  const savedTs = (r) => (Number.isFinite(r.ts) && r.ts > 0 ? Math.floor(r.ts) : null);
  const saved = persist && persist.load ? persist.load() : null;
  const seed = (Array.isArray(saved) ? saved : []).filter((r) => r !== null && typeof r === 'object');
  const runs = (cap > 0 ? seed.slice(-cap) : []).map((r) => ({
    ts: savedTs(r),
    ok: Boolean(r.ok),
    reason: r.ok ? null : (r.reason || 'unknown'),
    recovered: Boolean(r.recovered),
  }));
  const flush = () => { if (persist && persist.save) persist.save(runs); };
  // Trailing runs that share `ok`. Counted from the newest end, so it answers
  // "what has happened SINCE" — the one thing the counts cannot express, because
  // they are order-blind: 1 failure of 3 is the same rate whether the failure was
  // the oldest run or the newest, and those are opposite situations.
  const trailing = (want) => {
    let n = 0;
    for (let i = runs.length - 1; i >= 0 && runs[i].ok === want; i -= 1) n += 1;
    return n;
  };
  return {
    record(ok, reason, recovered) {
      runs.push({
        ts: now(),
        ok: Boolean(ok),
        reason: ok ? null : (reason || 'unknown'),
        recovered: Boolean(recovered),
      });
      while (runs.length > Math.max(cap, 0)) runs.shift();
      flush();
    },
    // Counts say HOW OFTEN, the trailing runs say WHAT SINCE, and the timestamps
    // say HOW LONG AGO. This publishes all three and grades none of them: what
    // counts as healthy is the consumer's call, and it cannot make that call
    // without them. Every `*_ts` is epoch millis, or null when unknown — an empty
    // window, or entries written before `ts` existed.
    snapshot() {
      const degraded = runs.filter((r) => !r.ok);
      const stamps = runs.filter((r) => r.ts != null).map((r) => r.ts);
      const lastFailure = degraded.length ? degraded[degraded.length - 1] : null;
      return {
        recent: runs.length,
        degraded: degraded.length,
        recovered: runs.filter((r) => r.recovered).length,
        // Successes since the last failure, and failures since the last success.
        // The first proves a recovery by evidence rather than by elapsed time;
        // the second makes a fresh outage visible immediately instead of waiting
        // for it to dilute the window enough to move the rate.
        consecutive_ok: trailing(true),
        consecutive_failed: trailing(false),
        last_reason: lastFailure ? lastFailure.reason : null,
        // When the most recent failure happened — the one `last_reason` names.
        // Read from the same object, so the two can never name different runs.
        last_failure_ts: lastFailure ? lastFailure.ts : null,
        // The span the window actually covers, as min/max over the entries that
        // HAVE a time. Deliberately not the first and last positions: `Date.now()`
        // is a wall clock, so an NTP step backwards or a corrected RTC puts
        // neighbouring entries out of order, and a positional read would then
        // publish a span that ends before it starts. `window_to_ts` is the time of
        // the newest ENTRY, never the time this snapshot was taken.
        window_from_ts: stamps.length ? Math.min(...stamps) : null,
        window_to_ts: stamps.length ? Math.max(...stamps) : null,
      };
    },
  };
}

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
  // bucket is touched, so it cannot starve other callers. The global burst is
  // env-tunable (CLAUDE_PROMPT_RATE_BURST) for busy installs and deterministic
  // tests; the default preserves the production behavior.
  const globalBurst = Math.max(1, Number(process.env.CLAUDE_PROMPT_RATE_BURST) || 20);
  const globalBucket = new Bucket(globalBurst, 0.5);
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

// Optional per-day spend cap (USD) for the chat, so a runaway automation or heavy
// use cannot silently drain the plan. limitUsd <= 0 disables it. The window is a
// calendar day (UTC); spend resets on day change and on add-on restart (a restart
// is a privileged action, so this is a guardrail, not a hard billing gate).
function createBudget(limitUsd, now = () => new Date(), persist = null) {
  let day = '';
  let spent = 0;
  // Optionally restore today's spend from a durable store so a restart mid-day
  // doesn't silently reset the cap. A stale day is handled by roll() below.
  const saved = persist && persist.load ? persist.load() : null;
  if (saved && typeof saved.spent === 'number') {
    day = typeof saved.day === 'string' ? saved.day : '';
    spent = saved.spent;
  }
  const flush = () => { if (persist && persist.save) persist.save({ day, spent }); };
  const roll = () => {
    const d = now().toISOString().slice(0, 10);
    if (d !== day) { day = d; spent = 0; flush(); }
  };
  return {
    enabled: limitUsd > 0,
    limit: limitUsd,
    exceeded() {
      if (!(limitUsd > 0)) return false;
      roll();
      return spent >= limitUsd;
    },
    add(cost) {
      if (!(limitUsd > 0) || !(cost > 0)) return;
      roll();
      spent += cost;
      flush();
    },
    spent() { roll(); return spent; },
  };
}

// Durable, best-effort JSON state under the add-on's /data (survives restarts).
// load() is synchronous (called once, at startup); save() stays fire-and-forget,
// because a write failure must never break the chat.
//
// Writes are SERIALISED and ATOMIC. Those are two independent defects, and each
// one alone leaves the other:
//
//   Serialised — save() is called on every mutation, so two writes can be in
//   flight at once, and with a bare writeFile the winner is whichever FINISHES
//   last, not whichever started last. Measured on the previous code: at two and
//   three concurrent flushes the file was left OLDER than memory in 15 % and
//   47 % of trials, so a restart silently dropped the newest runs. Renaming
//   without ordering does not fix this — two renames race exactly the same way.
//
//   Atomic — writeFile truncates before it writes, so a process killed partway
//   through (which is every add-on update) leaves a half-document that JSON.parse
//   rejects, and the whole history then reads back as "nothing here". Ordering
//   without renaming does not fix this either; only a complete file appearing in
//   one step does.
//
// The payload is stringified at CALL time, so what eventually lands is the state
// as of the save() that queued it, applied in that order.
function fileStore(file) {
  // Reporting must never be able to affect a write. It is the only step in the
  // chain that calls out of this module, and if it threw, the terminal handler
  // would turn a SUCCESSFUL write into a reported failure — and, worse, leave the
  // chain rejected, which is fatal for a promise nothing awaits.
  const report = (msg) => { try { console.error(msg); } catch { /* never */ } };

  // The temp name is per INSTANCE, not per path. Two stores over one file would
  // otherwise share it while their chains stayed independent, and the writes
  // trample each other again — measured, 4 unreadable results in 200 concurrent
  // rounds. Nothing here builds two stores on one path; not relying on that
  // costs one random suffix.
  //
  // The suffix costs one thing back, so it is paid for here: a fixed name was
  // self-cleaning, because the next write simply overwrote whatever a killed
  // process had left. A random one never collides, so an orphan would survive
  // forever — and a process killed between the write and the rename is the exact
  // event this whole store exists to survive. Sweeping siblings at CONSTRUCTION
  // keeps both properties: this runs before this instance has written anything,
  // and the add-on builds its stores once, at startup.
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.tmp-`;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      // Guarded per ENTRY, not around the loop: one thing that cannot be removed
      // — a directory wearing the prefix, say — would otherwise abort the sweep
      // and leave every real orphan behind it in place, silently. Never
      // `recursive`, so this can only ever unlink a single file.
      try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* skip it */ }
    }
  } catch { /* no directory yet, or unreadable — the writes below will say so */ }
  const tmp = `${file}.tmp-${crypto.randomBytes(6).toString('hex')}`;

  let chain = Promise.resolve();
  let failing = false;
  return {
    load() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        // "No file yet" and "the file is damaged" both have to return null, but
        // they are not the same event and must not look the same in the log: the
        // first is a fresh install, the second is history that just disappeared.
        if (!err || err.code !== 'ENOENT') {
          report(`[prompt] state file unreadable, starting empty: ${file} — ${err && err.message ? err.message : err}`);
        }
        return null;
      }
    },
    save(obj) {
      const body = JSON.stringify(obj);
      chain = chain
        .then(() => fsp.writeFile(tmp, body, { mode: 0o600 }))
        .then(() => fsp.rename(tmp, file))
        .then(() => {
          if (failing) {
            failing = false;
            report(`[prompt] state file is writable again: ${file}`);
          }
        })
        .catch(async (err) => {
          // Fire-and-forget stays fire-and-forget — a write failure must never
          // break the chat — but it must not be INVISIBLE. A read-only /data or
          // a full disk otherwise leaves an add-on that looks perfectly healthy
          // until a restart quietly rolls the reliability window and the day's
          // recorded spend back to whatever was last written. That is the same
          // silent loss the load() message above exists for, noticed a day
          // earlier. Logged on the healthy->failing EDGE only, so a persistent
          // failure reports once instead of on every chat.
          if (!failing) {
            failing = true;
            report(`[prompt] state file write FAILED, this state will not survive a restart: ${file} — ${err && err.message ? err.message : err}`);
          }
          await fsp.unlink(tmp).catch(() => {}); // a rename that failed leaves it behind
        })
        // The chain must NEVER end rejected. In production nothing awaits save(),
        // and an unhandled rejection ends the process — so a store whose whole
        // purpose is to survive a bad day must not be able to cause one.
        .catch(() => {});
      return chain;
    },
  };
}

// Downscale a snapshot to ~1024px on the long edge and re-encode JPEG, so a
// multi-megapixel camera frame does not blow up Claude's vision token cost.
// Best-effort via the bundled ImageMagick; on ANY failure (magick missing, a
// non-image, a timeout) the original file is used unchanged — vision still
// works, just costlier. Output stays 0600.
async function resizeSnapshot(srcFile, workDir, execImpl = execFile) {
  const out = path.join(workDir, `snap-${crypto.randomBytes(9).toString('hex')}.jpg`);
  try {
    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      // `1024x1024>` = shrink to fit only if larger; never upscale. execImpl
      // passes args literally (no shell), so the `>` is a plain argument.
      execImpl('magick', [srcFile, '-resize', '1024x1024>', '-quality', '85', out],
        { timeout: 15000 }, (err) => (err ? reject(err) : resolve()));
    }));
    if ((await fsp.stat(out)).size === 0) throw new Error('empty output');
    await fsp.chmod(out, 0o600);
    await fsp.rm(srcFile, { force: true });
    return out;
  } catch {
    await fsp.rm(out, { force: true }).catch(() => {});
    return srcFile;
  }
}

// Fetch a camera's current snapshot with the (restricted) HA token and write it
// to a 0600 temp file in workDir, downscaled for a sane vision token cost.
// Returns the file path, or null on any failure (no image → the model just
// answers without vision). Bounded by SNAPSHOT_CAP_BYTES.
async function fetchSnapshot(entity, relay, workDir, fetchImpl = fetch) {
  if (!relay || !relay.url || !relay.token || !CAMERA_ENTITY_RE.test(entity)) return null;
  let resp;
  try {
    // Through the loopback relay, which holds the HA token and owns how Core is
    // reached — including when Core terminates TLS itself. (ClaudeInHA#47)
    resp = await fetchImpl(`${relay.url}/api/camera_proxy/${entity}`, {
      headers: { Authorization: `Bearer ${relay.token}` },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length === 0 || buf.length > SNAPSHOT_CAP_BYTES) return null;
  const file = path.join(workDir, `snap-${crypto.randomBytes(9).toString('hex')}.jpg`);
  try {
    await fsp.writeFile(file, buf, { mode: 0o600 });
  } catch {
    return null;
  }
  return resizeSnapshot(file, workDir);
}

function createPromptApp({
  token, claudeBin, usageBin, mcpConfigPath, model, voiceModel = '', dailyBudgetUsd = 0,
  coreRelayUrl = '', coreRelayToken = '',
  workDir, addonVersion, redact, audit, stateDir = null, dataDir = null,
}) {
  const app = express();
  app.disable('x-powered-by');

  let activeRuns = 0;
  // Bounded per-conversation chat history for the read path (memory). Keyed by
  // the client-supplied conversation_id, so it is hard-capped inside history.js.
  const conversations = createHistoryStore();
  // Optional daily spend cap for the chat. Durable across restarts when a
  // stateDir is provided, so a mid-day restart doesn't reset the cap.
  const budget = createBudget(
    dailyBudgetUsd, undefined,
    stateDir ? fileStore(path.join(stateDir, 'budget.json')) : null,
  );
  // Whether the most recent read actually CONNECTED to the HA MCP server (vs.
  // merely being configured). null until the first read. Surfaced in /api/status
  // so the integration's health check can tell "configured but not connecting"
  // (e.g. the Model Context Protocol Server integration is missing) apart from
  // "connected". Distinct from ha_mcp, which only says a config file exists.
  let lastMcpConnected = null;
  // The `ha` MCP tool names the last run actually saw. Home Assistant renames
  // them across releases and namespaces them under `MergedAPI`, so the allowlist
  // is built from THIS rather than from a pinned string (see runner.js). Empty
  // until the first run reports in — the runner falls back to the bare names then.
  let haToolCatalog = null;
  // Rolling chat-health window; durable across restarts when a stateDir is
  // provided so the health sensor's history isn't wiped on every update.
  const chatHealth = createChatHealth(
    50, stateDir ? fileStore(path.join(stateDir, 'chat-health.json')) : null,
  );

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

  // Current proactive-alerts set for /api/status. The deterministic alerts loop
  // (cc-alerts, a SEPARATE service) persists the active anomalies to
  // <dataDir>/alerts-state.json — note the /data root, not the prompt server's own
  // claude-prompt subdir. Read fresh each call (tiny file). These lines carry the
  // user's OWN home entity names/values (their home data, NOT chat/model content),
  // surfaced so the integration can offer an "active home alerts" sensor; hence no
  // redaction. Absent/unreadable/malformed → null (e.g. proactive alerts never ran).
  // NOTE the two `active`s are different shapes across the file boundary: the state
  // file's `.active` is the array of anomaly KEYS (cc-alerts' dedup memory); the
  // response's `alerts.active` below is a COUNT, computed from `.items` so it can
  // never disagree with the item list.
  function alertsSnapshot() {
    if (!dataDir) return null;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dataDir, 'alerts-state.json'), 'utf8'));
      // Old-format file (pre-1.39.0: {active:[keys]} with no `items`) → "no data
      // yet" (null → sensor unavailable), NOT a false "0 active alerts". This only
      // shows for the ~2 min after a 1.39.0 upgrade until cc-alerts' first cycle
      // rewrites the file with items. A genuine new-format empty set is `items:[]`.
      if (!Array.isArray(s.items)) return null;
      const { items } = s;
      return {
        active: items.length,
        critical: items.reduce((n, i) => n + (i && i.critical === true ? 1 : 0), 0),
        items,
      };
    } catch { return null; }
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
      ha_mcp_connected: mcpConfigPath ? lastMcpConnected : false,
      chat_health: chatHealth.snapshot(),
      // The add-on's wall-clock ceiling per request (a TIME) — lets the client pair
      // its own REQUEST_TIMEOUT dynamically. Distinct from the daily-$ budget below.
      prompt_timeout_ms: TIMEOUT_MS,
      // Daily chat spend cap for a budget sensor (limit 0 = unlimited).
      budget: { limit: budget.limit, spent: Number(budget.spent().toFixed(4)) },
      // Current proactive-alerts set (or null when the alerts loop hasn't run) —
      // the user's own home entity names/values, so the integration can offer an
      // active-alerts sensor. See alertsSnapshot() above.
      alerts: alertsSnapshot(),
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
      // Optional language hint for the server-authored notices (degrade / budget);
      // normalized to a supported code with an English fallback.
      if (body.language !== undefined && typeof body.language !== 'string') {
        return res.status(400).json({ error: 'language must be a string' });
      }
      const language = langOf(body.language);

      // Optional surface hint: "voice" makes the model keep the reply short and
      // TTS-friendly (spoken aloud). Absent → today's behavior (text-length).
      if (body.surface !== undefined && body.surface !== 'voice' && body.surface !== 'text') {
        return res.status(400).json({ error: 'surface must be "voice" or "text"' });
      }

      // Optional existing-automation config: when present, the model MODIFIES this
      // automation (applies the requested change to the config below) instead of
      // drafting a brand-new one, returning the full updated config in the same
      // `automation` field. Must be a plain JSON object (the automation's current
      // config) — an array/string/null is malformed. Absent → today's behavior.
      if (body.edit_automation !== undefined
          && (typeof body.edit_automation !== 'object'
              || body.edit_automation === null
              || Array.isArray(body.edit_automation))) {
        return res.status(400).json({ error: 'edit_automation must be a JSON object' });
      }

      // Camera vision: an optional camera entity to snapshot and let Claude SEE.
      // Read-only, strict entity format; the integration must only pass cameras
      // the user has exposed to Assist (that is the outer boundary).
      let imageEntity = null;
      if (body.image_entity !== undefined) {
        if (mode !== 'read') {
          return res.status(400).json({ error: 'image_entity is only valid with mode "read"' });
        }
        if (typeof body.image_entity !== 'string' || !CAMERA_ENTITY_RE.test(body.image_entity)) {
          return res.status(400).json({ error: 'image_entity must be a camera.<id> entity' });
        }
        imageEntity = body.image_entity;
      }

      // Optional SSE streaming of the answer text (read only).
      if (body.stream !== undefined && typeof body.stream !== 'boolean') {
        return res.status(400).json({ error: 'stream must be a boolean' });
      }
      if (body.stream === true && mode !== 'read') {
        return res.status(400).json({ error: 'stream is only valid with mode "read"' });
      }
      const streaming = body.stream === true;

      // Unconfirmed (auto) vs user-confirmed writes. Default "confirmed"
      // preserves the pre-1.8 contract: absent === the integration already got
      // the user's explicit yes. "auto" is the opt-in low-risk fast path.
      const confirmation = body.confirmation === undefined ? 'confirmed' : body.confirmation;
      if (confirmation !== 'auto' && confirmation !== 'confirmed') {
        return res.status(400).json({ error: 'confirmation must be "auto" or "confirmed"' });
      }
      if (mode !== 'write' && body.confirmation !== undefined) {
        return res.status(400).json({ error: 'confirmation is only valid with mode "write"' });
      }

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
        // Boundary backstop: an auto (unconfirmed) write may never touch an
        // inherently critical domain, regardless of caller/model intent.
        if (confirmation === 'auto') {
          const blocked = [...new Set(
            intents.flatMap((i) => i.targets)
              .map((t) => t.split('.')[0])
              .filter((d) => CRITICAL_NEVER_AUTO.has(d)),
          )];
          if (blocked.length) {
            audit(`prompt[deny] reason=auto-critical caller=${caller} domains=${blocked.join('+')}`);
            return res.status(403).json({ error: 'sensitive action requires explicit confirmation', domains: blocked });
          }
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

      // 4b. Daily chat spend cap. Enforced on the read path — it is the
      // expensive, conversation-driving call, and blocking it also halts any
      // follow-on auto-write. Returns a plain 200 so the chat surfaces a friendly
      // message (no error) and no Claude process is spawned (so no further spend).
      if (mode === 'read' && budget.exceeded()) {
        audit(`prompt[deny] reason=budget caller=${caller} spent=$${budget.spent().toFixed(4)}/${budget.limit}`);
        return res.status(200).json({
          text: budgetNotice(language, budget.limit),
          proposal: null,
          tools_used: [],
          truncated: false,
        });
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

      // Fetch the requested camera snapshot (if any) before running Claude; a
      // failed fetch simply yields no image and the model answers without vision.
      const imagePath = imageEntity
        ? await fetchSnapshot(imageEntity, { url: coreRelayUrl, token: coreRelayToken }, workDir)
        : null;

      // For streaming, open an NDJSON response now and emit REDACTED text deltas
      // as the answer generates — one JSON object per line, which the companion
      // integration consumes with a plain aiohttp line reader. A safety window
      // holds back the trailing chars so a secret split across fragments is
      // redacted before any of it ships; the terminal `done` line is
      // authoritative. If no deltas arrive (older CLI / no streamable text), the
      // client simply gets the final `done` line — no breakage.
      let emittedLen = 0;
      let onText;
      if (streaming) {
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        });
        onText = (fullText) => {
          const redacted = redact(fullText);
          const safeLen = Math.max(0, redacted.length - STREAM_SAFETY_WINDOW);
          if (safeLen > emittedLen) {
            const chunk = redacted.slice(emittedLen, safeLen);
            emittedLen = safeLen;
            try { res.write(`${JSON.stringify({ type: 'delta', text: chunk })}\n`); } catch { /* client gone */ }
          }
        };
      }

      let outcome;
      let attempts = 0;
      // Why a retry was needed, for the success audit below. A run that only
      // succeeded on the second attempt looked identical to a clean one before —
      // which is how a whole class of silent failures stayed invisible (#58).
      let recoveredFrom = null;
      let spent = 0; // real API cost of EVERY attempt (billed even on a failed/degraded read)
      // A voice turn uses the (optional) faster voice model; everything else uses
      // the normal chat model. Resolved ONCE here so the run and the audit can't
      // disagree about which model actually served the turn (empty → Claude default).
      const resolvedModel = (body.surface === 'voice' && voiceModel) ? voiceModel : model;
      try {
        // 6. Run Claude (stateless, scrubbed, deny-by-default). A read whose run
        //    fails to a TRANSIENT reason is retried (the identical prompt commonly
        //    succeeds), EXCEPT a camera-vision read (its snapshot is single-use) or
        //    a stream that already shipped deltas (they cannot be un-sent). One
        //    logical request holds the one concurrency slot across its attempts.
        for (;;) {
          attempts += 1;
          // eslint-disable-next-line no-await-in-loop
          outcome = await runClaude({
            bin: claudeBin,
            prompt,
            mode,
            intents: intents || [],
            mcpConfigPath,
            // A voice turn uses the (optional) faster voice model — spoken replies
            // are short, so lower latency beats raw capability. Falls back to the
            // normal model when unset. Applies to voice writes too (snappy confirms).
            model: resolvedModel,
            cwd: workDir,
            signal: abort.signal,
            history: (mode === 'read' && conversationId)
              ? conversations.recent(conversationId) : undefined,
            imagePath,
            onText,
            // Raw HA language tag → the model answers in the user's own language
            // (the runner validates it as a well-formed tag before use). Distinct
            // from `language` above (the en/uk/pl-normalized code for notices).
            language: body.language,
            // "voice" → append a spoken-aloud brevity directive (read only).
            surface: body.surface,
            // Existing automation config → the model MODIFIES it (read only): the
            // runner embeds it and returns the full updated config in `automation`.
            editAutomation: body.edit_automation,
            // Live `ha` tool names, so a run allowlists what HA actually publishes.
            haTools: haToolCatalog,
            // First attempt gets the full ceiling; a retry gets only what's LEFT of
            // the one-request budget, so TOTAL wall-clock across attempts never
            // exceeds TIMEOUT_MS (the client can pair its timeout to that one bound).
            timeoutMs: attempts === 1 ? undefined : Math.max(0, TIMEOUT_MS - (Date.now() - started)),
          });
          spent += Number(outcome.costUsd) || 0;
          // Learn the published tool names from EVERY attempt (success or not) —
          // this is what makes the next run track an HA rename on its own.
          if (Array.isArray(outcome.haTools) && outcome.haTools.length > 0) {
            haToolCatalog = outcome.haTools;
          }
          // A write normally never retries: a state change that may have already
          // run must not be repeated. A tool-name mismatch is the one exception
          // that is provably safe — it is raised at init and the guard below holds
          // it to a run where NO tool ran at all, so nothing can be repeated.
          const preExecutionMismatch = outcome.status === 'error'
            && outcome.reason === 'tool-name-mismatch'
            && (outcome.toolsUsed || []).length === 0;
          const retryable = outcome.status === 'error'
            && (mode === 'read' || preExecutionMismatch)
            && !imagePath
            && !(streaming && emittedLen > 0)
            && RETRYABLE_REASONS.has(outcome.reason)
            && attempts < MAX_ATTEMPTS
            && !res.writableEnded // client still connected
            && (TIMEOUT_MS - (Date.now() - started)) > MIN_RETRY_BUDGET_MS; // budget left to be worth it
          if (!retryable) break;
          recoveredFrom = outcome.reason;
          // eslint-disable-next-line no-await-in-loop
          await delay(RETRY_BACKOFF_MS);
        }
      } finally {
        activeRuns -= 1;
        // Always delete the snapshot — it lived only for this one call.
        if (imagePath) fsp.rm(imagePath, { force: true }).catch(() => {});
      }
      // Bill EVERY attempt's real cost against the daily cap — including a failed or
      // degraded read (the tokens were spent regardless of the final outcome).
      budget.add(spent);

      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      // Audit the confirmed intents/targets for write, the prompt hash for read.
      const detail = mode === 'write'
        ? `intents=${intents.map((i) => `${i.intent}(${i.targets.join('+')})`).join(',')}`
        : `len=${Buffer.byteLength(prompt, 'utf8')} sha=${sha12(prompt)}`;
      const base = `caller=${caller}${conversationId ? ` conv=${conversationId}` : ''}`
        + `${imageEntity ? ` img=${imageEntity}${imagePath ? '' : '(fetch-failed)'}` : ''}`
        + ` lang=${language} langdir=${safeLangTag(body.language) || '-'}`
        + ` surface=${body.surface || '-'} model=${sanitizeId(resolvedModel, 64) || 'default'}`
        + `${body.edit_automation !== undefined ? ' edit=1' : ''} ${detail}`;

      // A streaming READ must NEVER terminate with `{type:"error"}` — the
      // integration's NDJSON reader treats that as fatal and the chat hard-fails,
      // which would defeat graceful degradation on the primary path. So every
      // streaming-read failure (a transient error surviving retry, OR a timeout)
      // ends with a friendly `done` carrying the degrade body. The NDJSON headers
      // are already sent, so there is no HTTP status to set. (Writes never stream.)
      const streamDone = (payload) => {
        try { res.write(`${JSON.stringify({ type: 'done', ...payload })}\n`); } catch { /* client gone */ }
        try { res.end(); } catch { /* client gone */ }
      };
      const failStream = (err) => {
        try { res.write(`${JSON.stringify({ type: 'error', error: err })}\n`); } catch { /* gone */ }
        try { res.end(); } catch { /* gone */ }
      };
      const degradedBody = {
        text: DEGRADE_TEXT[language], proposal: null, tools_used: [], truncated: false, degraded: true,
      };
      if (outcome.status === 'timeout') {
        audit(`prompt[${mode}] ${base} status=504 dur=${seconds}s`);
        if (mode === 'read') chatHealth.record(false, 'timeout', false);
        if (streaming) { streamDone(degradedBody); return undefined; }
        return res.status(504).json({ error: 'timeout' });
      }
      if (outcome.status !== 'ok') {
        // Observability: carry the reason + whatever turns/tools the failed run did
        // show into the audit — all of this was dropped before, leaving 500s blind.
        const reason = outcome.reason || 'unknown';
        const diag = `reason=${reason} attempts=${attempts} turns=${outcome.numTurns ?? '?'}`
          + ` tools=${(outcome.toolsUsed || []).map((t) => sanitizeId(t, 64)).join('|') || '-'}`
          + ` cost=$${spent.toFixed(4)}`;
        console.error(`[prompt] run failed (${caller}): ${reason} — ${redact(outcome.message || 'unknown')}`);
        // Read: never let the chat die — degrade to a friendly 200 (the run already
        // retried where it could). Write: fail honestly with 500 — a state-changing
        // action must NEVER report a fabricated success.
        if (mode === 'read') {
          // Health signal reflects the USER's experience, not the raw envelope.
          // A streaming read that already shipped deltas hit a late/transient error
          // but the user still received a real answer — an ABSORBED transient
          // (recovered), NOT user-visible degradation. Only a turn where the user
          // gets the apology (no content streamed) counts as degraded. (The audit
          // below still records the raw `200-degraded reason=` either way.)
          const delivered = streaming && emittedLen > 0;
          chatHealth.record(delivered, delivered ? null : reason, delivered);
          audit(`prompt[read] ${base} status=200-degraded ${diag} dur=${seconds}s`);
          if (streaming) { streamDone(degradedBody); return undefined; }
          return res.status(200).json(degradedBody);
        }
        audit(`prompt[write] ${base} status=500 ${diag} dur=${seconds}s`);
        if (streaming) return failStream('internal error');
        return res.status(500).json({ error: 'internal error' });
      }

      // (Cost was already billed for every attempt above, via budget.add(spent).)
      // Remember whether the read path reached the HA MCP server (for /api/status).
      // Only move the signal when the read gave real evidence (used the ha tool, or
      // saw it connected at init); a read that never touched MCP leaves the last
      // known value — this stops a state-free turn right after a restart from
      // falsely flipping ha_mcp_connected and raising a bogus "MCP unreachable".
      if (mode === 'read' && outcome.mcpConnected != null) lastMcpConnected = outcome.mcpConnected;
      // Health signal: a successful read (recovered=true if a retry rescued it).
      if (mode === 'read') chatHealth.record(true, null, attempts > 1);

      // 7. Output: redact secrets from EVERY model-shaped field before it
      // leaves the add-on — text, the whole proposal (summary + each intent's
      // free-form data), and the tool names.
      const text = redact(outcome.text);
      // Remember this read turn (redacted text only) so the next turn in the same
      // conversation has context. Write turns are intent-driven and not recorded.
      if (mode === 'read' && conversationId) {
        conversations.append(conversationId, prompt, text);
      }
      const proposal = outcome.proposal ? redactDeep(outcome.proposal, redact) : null;
      // Automation draft (read-side): a model-drafted automation config, redacted like the
      // proposal. Additive/optional — absent on every non-automation turn, so an
      // old integration that doesn't read it is unaffected. The add-on never
      // commits it; the integration re-validates + writes it in-process on confirm.
      const automation = outcome.automation ? redactDeep(outcome.automation, redact) : null;
      const toolsUsed = outcome.toolsUsed.map((t) => redact(t));

      const cost = outcome.costUsd == null ? '' : ` cost=$${Number(outcome.costUsd).toFixed(4)}`;
      audit(
        `prompt[${mode}] ${base} status=200 dur=${seconds}s turns=${outcome.numTurns ?? '?'}`
        + ` tools=${outcome.toolsUsed.map((t) => sanitizeId(t, 64)).join('|') || '-'}`
        + ` out=${Buffer.byteLength(text, 'utf8')}B${outcome.truncated ? ' truncated' : ''}`
        + `${attempts > 1 ? ` attempts=${attempts} recovered=${recoveredFrom}` : ''}`
        + `${outcome.mcpFailed ? ' mcp=FAILED' : ''}${proposal ? ' proposal=yes' : ''}`
        + `${automation ? ' automation=draft' : ''}${cost}`,
      );
      if (outcome.mcpFailed) {
        console.error('[prompt] HA MCP server did not connect — check the add-on log for the resolved Core address, that the Model Context Protocol Server integration is installed, and the HA token');
      }

      const responseBody = {
        text,
        proposal,
        // Only present when the model drafted an automation, so the field is
        // absent — not null — for ordinary turns; the integration keys on its
        // presence and old clients ignore it.
        ...(automation ? { automation } : {}),
        tools_used: toolsUsed,
        truncated: outcome.truncated,
      };
      if (streaming) {
        // Flush any tail the safety window held back, then one terminal `done`
        // line carrying the authoritative payload (full redacted text + proposal).
        // The deltas already reconstruct `text`; it is repeated in `done` for
        // resilience, and the client treats `done` as truth.
        if (text.length > emittedLen) {
          res.write(`${JSON.stringify({ type: 'delta', text: text.slice(emittedLen) })}\n`);
        }
        res.write(`${JSON.stringify({ type: 'done', ...responseBody })}\n`);
        return res.end();
      }
      res.json(responseBody);
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

module.exports = {
  createPromptApp, createRateLimiter, createBudget, createChatHealth, fileStore, fetchSnapshot, resizeSnapshot, Bucket,
};
