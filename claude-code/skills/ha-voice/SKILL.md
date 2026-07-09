---
name: ha-voice
description: Set up voice control (speech in and out) for Assist in a chosen language — especially Ukrainian, Polish, or any language Home Assistant's English-only default does not offer — using local Whisper (speech-to-text) + Piper (text-to-speech) with Claude as the conversation agent. Use when the user wants to TALK to Claude by voice in their language, or says Assist voice has no option for their language on their phone.
---

Assist voice = three stages: **STT** (speech → text) → **conversation agent** (Claude) → **TTS** (text → speech). Claude (the companion integration's agent — it appears in the Assist dropdown as **"Claude Code"**, and declares `supported_languages = MATCH_ALL`, so it never restricts the pipeline language) already understands every language — the only gap for non-English voice is the STT/TTS engines. This wires up a **fully local** pipeline: **Whisper** (STT, multilingual) + **Piper** (TTS) + Claude, in the user's language. The only cloud call is Claude itself, exactly like the text chat.

**Key architecture (verified live 2026-07-09):** install Whisper and Piper **ONCE** (not per language). A single multilingual Whisper + a single Piper serve **all** languages — each Assist assistant (pipeline) carries its own language, which is passed to the engines per request, and Piper downloads the requested voice on demand. So for N languages you create N **assistants**, all pointing at the **same** two engines. Do NOT hard-pin Whisper to one language.

Prefer driving the Supervisor via the console `ha` CLI over raw curl. Add-ons are addressed by **slug**.

## 1. Whisper — speech-to-text (install once, multilingual)
```bash
ha addons | grep -iE 'whisper|faster'          # find the slug (usually core_whisper)
ha addons install core_whisper 2>&1 || echo "already installed"
```
In **Settings → Add-ons → Whisper → Configuration**, set:
- **Model:** `small-int8` — multilingual (NOT a `.en` model) and int8-compressed for speed; good balance for uk/pl. Drop to `base-int8` on a weak CPU (faster, less accurate).
- **Language:** `auto` — so Whisper never FORCES one language; it uses each pipeline's language (or detects). This is what lets one instance serve every language.
- **Whisper task:** `transcribe` (native language) — NOT `translate` (which would force English).

Then **Start**. (First start downloads the model.) CLI equivalent:
```bash
ha addons info core_whisper | sed -n '/options/,/^[^ ]/p'   # read current shape first
# set model=small-int8, language=auto, then: ha addons start core_whisper
```
Honest note: Whisper on CPU is a few seconds per phrase; `small-int8` uses noticeable RAM (~0.5 GB) — if the host is tight, `base-int8` is lighter. No GPU path in this add-on.

## 2. Piper — text-to-speech (install once, serves any voice)
```bash
ha addons | grep -i piper
ha addons install core_piper 2>&1 || echo "already installed"
```
**Leave the default `voice` as-is and just Start it** — Piper serves whatever voice each pipeline requests and downloads it on demand, so you do NOT pin a per-language voice here. You pick the actual voice per assistant in step 4.
```bash
ha addons start core_piper
```
Voice quality note (verified): each language offers several qualities — pick a **`(high)`** voice in step 4 where available. Ukrainian has good high voices (e.g. `tetiana`, `mykyta`, `oleksa` — all `high`), Polish `bass (high)`, English `lessac (high)`. (The old "Ukrainian Piper is low quality" caveat is outdated — the `lada (x_low)` default is the weak one; the `high` voices are fine.)

## 3. Let HA discover them (Wyoming)
Whisper/Piper announce themselves over **Wyoming** and appear under **Settings → Devices & services → Discovered** as **"Piper (Wyoming Protocol)"** and **"Whisper (Wyoming Protocol)"**. Click **Add → Submit → Finish** on each. (If they don't appear, add the **Wyoming Protocol** integration manually — it auto-finds the running add-ons.) Confirm the engines exist:
```bash
curl -sS -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://supervisor/core/api/states \
  | jq -r '.[].entity_id' | grep -iE 'stt|tts|wyoming' || echo "no stt/tts engines yet"
```

## 4. Create one Assist assistant per language (the manual GUI step)
**Settings → Voice assistants → Add assistant**, once per language:
1. **Name** e.g. "Claude (Українська)" / "Claude (Polski)" / "Claude (English)".
2. **Language:** the target language (search e.g. "Ukrainian").
3. **Conversation agent:** **Claude Code** (the companion integration's agent). Leave **"Prefer handling commands locally"** ON — HA handles device commands (turn on/off …) instantly/offline and hands only conversation to Claude.
4. **Speech-to-text:** **faster-whisper** — its Language auto-fills to the assistant's language (passed to Whisper per request).
5. **Text-to-speech:** **piper** — Language + Voice auto-fill; **change the Voice to a `(high)` one** for that language. "Try voice" previews it.
6. **Create.** Repeat for each language. The user picks which assistant on their device.

## 5. Verify (needs a microphone — the user's step)
Open **Assist** on the phone → in Assist settings select the new assistant → tap the mic → **speak** in that language (e.g. «Яка температура на кухні?»). Confirm Whisper transcribed → Claude answered → Piper spoke. If STT is slow → smaller Whisper model; if a voice sounds poor → another `(high)` voice or HA Cloud TTS (Nabu Casa).

## Notes
- Fully local & private (no cloud STT/TTS). Claude is the only cloud call, same as text chat.
- Only entities **exposed to Assist** are voice-controllable (Settings → Voice assistants → Expose) — the security boundary.
- The conversation agent is `MATCH_ALL`, so any language you pick for the assistant is accepted; the reply also follows that language (add-on ≥ 1.24.0 threads it into the model).
- Do NOT restart the Claude Code add-on you are running inside — it drops the console session.
