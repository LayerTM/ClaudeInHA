'use strict';

// Security primitives for the prompt server. Every boundary the request
// crosses lives here: network origin, identity, input shape, and what is
// allowed back out (redaction). Keep this file dependency-free.

const crypto = require('node:crypto');

// The Supervisor internal network (Core, Supervisor, add-ons) is
// 172.30.32.0/23; direct Core->add-on calls arrive from Core's own container
// IP anywhere in that subnet — NOT from the Supervisor gateway .2 the ingress
// console pins. Loopback is allowed for in-container tooling and the watchdog.
function ipAllowed(remoteAddress) {
  if (typeof remoteAddress !== 'string' || !remoteAddress) return false;
  let ip = remoteAddress;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1' || ip === '127.0.0.1') return true;
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const n = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (n.some((v) => !Number.isInteger(v) || v > 255)) return false;
  return n[0] === 172 && n[1] === 30 && (n[2] === 32 || n[2] === 33);
}

// Constant-time bearer comparison. Hash both sides first so length
// differences cannot leak through timingSafeEqual's length check.
function tokenMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  if (presented.length === 0 || expected.length < 16) return false;
  const a = crypto.createHash('sha256').update(presented, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

// Every control character except \n and \t: C0 (minus \t\n), DEL, C1.
// Built from codepoints so no literal control bytes live in this source file.
const CONTROL_CHARS_RE = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]', 'g',
);

// Normalize newlines, drop every other control character.
function sanitizePrompt(text) {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS_RE, '');
}

// One-line-safe identifier for audit records (defeats log injection).
function sanitizeId(value, max = 64) {
  if (typeof value !== 'string') return '';
  return value.replace(/[^\w.:@-]/g, '_').slice(0, max);
}

const ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;
const INTENT_RE = /^Hass[A-Za-z0-9_]{2,48}$/;

// Validate a client-supplied confirmed-intents array (write mode). Returns
// {ok:true, intents} with a normalized copy, or {ok:false, error}.
function validateIntents(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 5) {
    return { ok: false, error: 'intents must be an array of 1-5 entries' };
  }
  const intents = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, error: 'each intent must be an object' };
    }
    const { intent, targets, data } = entry;
    if (typeof intent !== 'string' || !INTENT_RE.test(intent)) {
      return { ok: false, error: 'invalid intent name' };
    }
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > 10
        || !targets.every((t) => typeof t === 'string' && t.length <= 100 && ENTITY_ID_RE.test(t))) {
      return { ok: false, error: 'invalid intent targets' };
    }
    let cleanData = {};
    if (data !== undefined) {
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return { ok: false, error: 'intent data must be an object' };
      }
      const json = JSON.stringify(data);
      if (json.length > 2048) return { ok: false, error: 'intent data too large' };
      cleanData = JSON.parse(json);
    }
    intents.push({ intent, targets: [...targets], data: cleanData });
  }
  return { ok: true, intents };
}

// Validate the model-produced proposal from structured output. Anything that
// does not strictly conform is dropped (null) — the model's output is
// untrusted.
function validateProposal(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  if (typeof raw.summary !== 'string' || !Array.isArray(raw.intents)) return null;
  const summary = sanitizePrompt(raw.summary).slice(0, 500).trim();
  if (!summary) return null;
  const rawIntents = raw.intents.slice(0, 5);
  const checked = validateIntents(rawIntents);
  if (!checked.ok) return null;
  // Attach the model's per-intent risk hint. It is UNTRUSTED (model output), so
  // it is only a UX hint for the integration; the integration's metadata-aware
  // classifier and the write-path domain backstop are the real gate. Default to
  // the safe value ("sensitive") whenever it is missing or malformed.
  const intents = checked.intents.map((it, i) => ({
    ...it,
    risk: rawIntents[i] && rawIntents[i].risk === 'low' ? 'low' : 'sensitive',
  }));
  return { summary, intents };
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const AUTOMATION_MODES = new Set(['single', 'restart', 'queued', 'parallel']);
// Cap on the serialized draft so a runaway model can't emit a huge config blob.
const AUTOMATION_DRAFT_MAX_BYTES = 8192;

// Validate a model-DRAFTED Home Assistant automation config (the read-side draft).
// The add-on only DRAFTS: it returns the config for display/confirmation —
// it NEVER commits it. The authoritative gate lives in the companion integration,
// which re-validates the dict with HA's own `async_validate_config_item` and
// enforces an action allowlist at commit time (deterministic, no LLM in the write
// path). So here we do STRUCTURAL sanity + size caps only, deliberately NOT
// semantic HA-schema validation (that's the integration's job) and NOT deep
// string-scrubbing of the config blocks (it would corrupt valid Jinja templates
// the integration re-inspects). Returns a normalized draft, or null when the
// shape is unusable. The blocks (triggers/conditions/actions) are passed through
// verbatim as HA config documents; redactDeep still scrubs secrets from them
// before the response leaves the add-on, same as every other structured field.
function validateAutomationDraft(raw) {
  if (!isPlainObject(raw)) return null;
  const alias = typeof raw.alias === 'string' ? sanitizePrompt(raw.alias).slice(0, 200).trim() : '';
  if (!alias) return null;
  if (!Array.isArray(raw.triggers) || !Array.isArray(raw.actions)) return null;
  const triggers = raw.triggers.filter(isPlainObject).slice(0, 20);
  const actions = raw.actions.filter(isPlainObject).slice(0, 40);
  if (triggers.length === 0 || actions.length === 0) return null;
  const draft = { alias, triggers, actions };
  if (Array.isArray(raw.conditions)) {
    const conditions = raw.conditions.filter(isPlainObject).slice(0, 20);
    if (conditions.length) draft.conditions = conditions;
  }
  if (typeof raw.description === 'string') {
    const description = sanitizePrompt(raw.description).slice(0, 500).trim();
    if (description) draft.description = description;
  }
  if (typeof raw.mode === 'string' && AUTOMATION_MODES.has(raw.mode)) draft.mode = raw.mode;
  // Reject an implausibly large draft outright rather than truncating it into an
  // invalid config the integration would only reject anyway.
  if (Buffer.byteLength(JSON.stringify(draft), 'utf8') > AUTOMATION_DRAFT_MAX_BYTES) return null;
  return draft;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Redactor: shape-based patterns for credential formats plus exact matches of
// every secret value this process knows about. Applied to all model output
// before it leaves the add-on (exfiltration-via-answer defense).
function buildRedactor(secretValues) {
  const exact = (secretValues || [])
    .filter((v) => typeof v === 'string' && v.length >= 8)
    .sort((a, b) => b.length - a.length)
    .map((v) => new RegExp(escapeRegExp(v), 'g'));
  const shapes = [
    /\bsk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic API keys
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, // JWT / HA LLAT
    /\b(?:Bearer|Token)\s+[A-Za-z0-9._~+/=-]{20,}/g, // auth header values
  ];
  return (text) => {
    if (typeof text !== 'string' || !text) return text;
    let out = text;
    for (const re of exact) out = out.replace(re, '[REDACTED]');
    for (const re of shapes) out = out.replace(re, '[REDACTED]');
    return out;
  };
}

// Redact every string of a JSON-ish value by serializing and running the string
// redactor over the whole blob at once — no recursion, so no depth limit. Used as
// the fallback when the tree walk hits its depth cap, so deeply-nested model
// output (e.g. an automation `choose`/`sequence` chain) can never smuggle a secret
// past the redactor by burying it. The redactor only ever replaces credential-
// SHAPED substrings (which exclude JSON structural characters like `"` `{` `,`)
// with a literal, so the result stays valid JSON; the try/catch is a belt-and-
// braces guard against any non-serializable input (unreachable for JSON-origin
// data — drop to null rather than risk leaking a raw value).
function redactViaJson(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  try {
    return JSON.parse(redact(JSON.stringify(value)));
  } catch {
    return null;
  }
}

// Apply a redactor to every string inside a JSON-ish value (strings, arrays,
// object values). Used so model-controlled structured output (proposal intents,
// their free-form `data`; the automation draft's arbitrarily-nested blocks) is
// redacted just like plain text — closing the exfiltration-via-answer channel for
// ALL response fields, not only text. The depth cap bounds recursion against
// pathological nesting; PAST the cap we do NOT return the value raw (that would
// leak secrets buried deep in a config document) — we fall back to whole-blob
// string redaction, which is depth-independent.
function redactDeep(value, redact, depth = 0) {
  if (depth > 8) return redactViaJson(value, redact);
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, redact, depth + 1);
    return out;
  }
  return value;
}

function sha12(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

module.exports = {
  ipAllowed,
  tokenMatches,
  sanitizePrompt,
  sanitizeId,
  validateIntents,
  validateProposal,
  validateAutomationDraft,
  buildRedactor,
  redactDeep,
  sha12,
};
