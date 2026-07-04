---
name: ha-voice
description: Set up voice control (speech in and out) for Assist in a chosen language — especially Ukrainian, Polish, or any language Home Assistant's English-only default does not offer — using local Whisper (speech-to-text) + Piper (text-to-speech) with Claude as the conversation agent. Use when the user wants to TALK to Claude by voice in their language, or says Assist voice has no option for their language on their phone.
---

Assist voice = three stages: **STT** (speech → text) → **conversation agent** (Claude) → **TTS** (text → speech). Claude (the `claude_ha` "Claude" agent) already understands every language — the only gap for non-English voice is the STT/TTS engines. This wires up a **fully local** pipeline: **Whisper** (STT, multilingual, incl. Ukrainian & Polish) + **Piper** (TTS, has Ukrainian & Polish voices) + Claude, in the user's language. The only cloud call is Claude itself, exactly like the text chat.

Confirm the target language first (Ukrainian `uk`, Polish `pl`, or another). It's per-language — run it again for a second language; the user picks per conversation on their device.

Use `$SUPERVISOR_TOKEN` (always in the env) for the Supervisor API. Add-ons are addressed by **slug**.

## 1. Whisper — speech-to-text
Find/confirm the official Whisper add-on slug (usually `core_whisper`) and install if missing:
```bash
ha addons | grep -iE 'whisper|faster'          # find the slug
ha addons install core_whisper 2>&1 || echo "already installed, or use the slug from the list"
```
Set a multilingual model + the language via the Supervisor API (reliable), then start it. Read current options first so you keep its shape:
```bash
ha addons info core_whisper | sed -n '/options/,/^[^ ]/p'
# faster-whisper is multilingual. Balance: "small-int8" (or "base-int8" on weak
# hardware). Set language so it does not mis-detect.
curl -sS -X POST -H "Authorization: Bearer $SUPERVISOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"options":{"model":"small-int8","language":"uk","beam_size":1}}' \
  http://supervisor/addons/core_whisper/options
ha addons start core_whisper
```
Honest note: Whisper on CPU is a few seconds per phrase; "base-int8" or a beefier host is faster (this add-on has no GPU path).

## 2. Piper — text-to-speech
```bash
ha addons | grep -i piper
ha addons install core_piper 2>&1 || echo "already installed, or use the slug from the list"
ha addons info core_piper | sed -n '/options/,/^[^ ]/p'
```
Pick a voice for the language. Do NOT guess the exact string — voice names change. Ukrainian voices look like `uk_UA-*`, Polish like `pl_PL-*` (e.g. `pl_PL-gosia-medium`). Check the current/allowed value in the add-on's own config docs or options, then set + start:
```bash
curl -sS -X POST -H "Authorization: Bearer $SUPERVISOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"options":{"voice":"uk_UA-ukrainian_tts-medium"}}' \
  http://supervisor/addons/core_piper/options            # adjust to a REAL voice for the language
ha addons start core_piper
```
Honest note: the Ukrainian Piper voice is lower quality than Polish. If it sounds rough, tell the user a different voice, or Home Assistant Cloud TTS (if they have Nabu Casa), is an option.

## 3. Let HA discover them (Wyoming)
Whisper/Piper expose themselves over the **Wyoming** protocol, usually auto-discovered once running. Check STT/TTS engines exist:
```bash
curl -sS -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://supervisor/core/api/states \
  | jq -r '.[].entity_id' | grep -iE 'stt|tts|wyoming' || echo "no stt/tts engines yet"
```
If none appear, tell the user to add the **Wyoming Protocol** integration (Settings → Devices & services → Add integration → *Wyoming Protocol*) — it auto-finds the running add-ons.

## 4. Create the Assist pipeline (the one manual step)
Pipelines are a Voice-assistants setting; guide the user through the clicks:
1. **Settings → Voice assistants → Add assistant**.
2. Name e.g. "Claude (Українська)"; **Language: Ukrainian** (or Polish).
3. **Conversation agent: Claude** (the claude_ha agent).
4. **Speech-to-text: faster-whisper** — choose the language.
5. **Text-to-speech: piper** — choose the voice from step 2.
6. Save, then set it **preferred**, or select it in the mobile app (Assist settings → this pipeline).

## 5. Verify
Ask the user to open Assist on their phone, switch to the new assistant, and **speak** a request in their language (e.g. «Яка температура на кухні?»). Confirm: Whisper transcribed it, Claude answered, Piper spoke the reply. If STT is slow → smaller Whisper model; if TTS sounds poor → another voice or Cloud TTS.

## Notes
- Fully local & private (no cloud STT/TTS). Claude is the only cloud call, same as text chat.
- Only entities **exposed to Assist** are voice-controllable (Settings → Voice assistants → Expose) — that's the security boundary.
- Do NOT restart the Claude Code add-on you are running inside — it drops your session.
