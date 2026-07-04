'use strict';

// Bounded per-conversation history for the read path. The `claude -p` layer stays
// STATELESS (every call is fresh — no --resume, no session files); this just
// remembers a few recent chat turns per conversation_id so the model has context
// ("and the bedroom?"). conversation_id is client-controlled, so the store is
// hard-bounded exactly like the rate-limiter Map — LRU cap on distinct ids, an
// idle TTL, and a per-conversation turn cap — and it holds only the already
// secret-redacted answer text, never raw model output.

const MAX_CONVERSATIONS = 200; // LRU cap on distinct conversation ids
const MAX_TURNS = 12; // ~6 user/assistant exchanges kept per conversation
const TTL_MS = 30 * 60 * 1000; // idle conversations expire
const CONTENT_CAP = 4 * 1024; // per stored message, bytes

function createHistoryStore(now = () => Date.now()) {
  // id -> { turns: [{ role: 'user'|'assistant', content }], stamp }
  // Map insertion order == recency: append() re-inserts to move an id to MRU.
  const store = new Map();

  function prune() {
    const cutoff = now() - TTL_MS;
    for (const [id, v] of store) {
      if (v.stamp < cutoff) store.delete(id);
    }
    while (store.size > MAX_CONVERSATIONS) {
      const oldest = store.keys().next().value;
      store.delete(oldest);
    }
  }

  const clip = (s) => (typeof s === 'string' ? s.slice(0, CONTENT_CAP) : '');

  return {
    // Recent turns for a conversation (oldest→newest), or [] if unknown/expired.
    recent(id) {
      if (!id) return [];
      const v = store.get(id);
      if (!v) return [];
      if (v.stamp < now() - TTL_MS) { store.delete(id); return []; }
      return v.turns;
    },
    // Record one exchange. assistantText should already be secret-redacted.
    append(id, userText, assistantText) {
      if (!id) return;
      let v = store.get(id);
      if (v) store.delete(id); // reinsert below to mark most-recently-used
      else v = { turns: [], stamp: 0 };
      v.turns.push({ role: 'user', content: clip(userText) });
      v.turns.push({ role: 'assistant', content: clip(assistantText) });
      if (v.turns.length > MAX_TURNS) v.turns = v.turns.slice(-MAX_TURNS);
      v.stamp = now();
      store.set(id, v);
      prune();
    },
    get size() { return store.size; },
  };
}

module.exports = { createHistoryStore, MAX_TURNS, TTL_MS };
