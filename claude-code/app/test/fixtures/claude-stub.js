#!/usr/bin/env node
'use strict';

// Deterministic stand-in for the `claude` CLI used by the prompt-server tests.
// It speaks just enough stream-json for the parser in ../../server/prompt/runner.js
// and branches on markers in the prompt it reads from stdin.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write('9.9.9 (Claude Code)\n');
  process.exit(0);
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => run(stdin));

function emit(obj) { process.stdout.write(`${JSON.stringify(obj)}\n`); }

function run(prompt) {
  const hasMcp = args.includes('--mcp-config');
  const schemaIdx = args.indexOf('--json-schema');
  const wantsProposal = schemaIdx !== -1 && args[schemaIdx + 1].includes('"proposal"');

  emit({
    type: 'system',
    subtype: 'init',
    tools: ['mcp__ha__GetLiveContext'],
    // MCPLATE simulates the `ha` server still connecting at init (it serves the
    // tool fine a moment later) — exercises the mcp=FAILED false-positive fix.
    mcp_servers: hasMcp
      ? [{ name: 'ha', status: (prompt.includes('MCPLATE') || prompt.includes('MCPNOEV')) ? 'pending' : 'connected' }] : [],
    permissionMode: 'dontAsk',
  });
  // A diagnostics line the parser must ignore (mirrors the real CLI's
  // "deny rule matches no known tool" warnings).
  process.stdout.write('Permission deny rule "Bogus" matches no known tool — check for typos.\n');

  if (prompt.includes('SLEEP')) { setTimeout(() => {}, 60000); return; } // hang until killed
  if (prompt.includes('SLOW')) { setTimeout(() => finish(prompt, wantsProposal), 1200); return; }
  if (prompt.includes('CRASH')) { process.exit(7); }
  if (prompt.includes('ISERROR')) {
    // A tool ran, then generation errored — so the error path has turns/tools to
    // surface (exercises the enriched error-audit).
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__ha__GetLiveContext', input: {} }] } });
    emit({
      type: 'result', subtype: 'error', is_error: true, result: 'model exploded', num_turns: 3,
    });
    process.exit(0);
  }
  if (prompt.includes('STREAMERR')) {
    // Streams substantial assistant TEXT (well past the server's 96-char safety
    // window) so the client RECEIVES a real answer, THEN the run errors — mirrors
    // a vision/read turn that finished streaming before a late transient
    // model-error. The user got the answer, so the health signal must treat this
    // as delivered (recovered), not a user-visible degrade. Only emits the
    // partial-message deltas when the server asked for them (streaming path).
    if (args.includes('--include-partial-messages')) {
      const wrap = (event) => emit({ type: 'stream_event', event });
      wrap({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'StructuredOutput', input: {} } });
      const full = JSON.stringify({ text: `delivered answer ${'lorem ipsum dolor '.repeat(18)}` });
      for (let i = 0; i < full.length; i += 17) {
        wrap({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: full.slice(i, i + 17) } });
      }
      wrap({ type: 'content_block_stop', index: 1 });
    }
    emit({
      type: 'result', subtype: 'error', is_error: true, result: 'late blip after full stream', num_turns: 4,
    });
    process.exit(0);
  }
  if (prompt.includes('MAXTURNS')) {
    // Deterministic exhaustion — carries a real cost and must NOT be retried.
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__ha__GetLiveContext', input: {} }] } });
    emit({
      type: 'result', subtype: 'error_max_turns', is_error: true, result: 'error_max_turns', num_turns: 20, total_cost_usd: 0.5,
    });
    process.exit(0);
  }
  if (prompt.includes('NOSTRUCT')) {
    emit({
      type: 'result', subtype: 'success', is_error: false,
      result: 'plain fallback text', num_turns: 1, total_cost_usd: 0.001,
    });
    process.exit(0);
  }
  if (prompt.includes('MCPNOEV')) {
    // A read that never touches the ha MCP tool (init showed it pending) → the run
    // gives NO reachability evidence, so ha_mcp_connected must not change.
    const s = { text: 'no tool used', proposal: null };
    emit({
      type: 'result', subtype: 'success', is_error: false,
      result: JSON.stringify(s), structured_output: s, num_turns: 1, total_cost_usd: 0.001,
    });
    process.exit(0);
  }
  // FLAKY:<token> — a transient model error on the FIRST spawn for a given token,
  // then a normal success on the next, so the server's retry-then-recover path is
  // exercised end to end. The marker file makes the "next spawn" stateful.
  const flaky = prompt.match(/FLAKY:(\w+)/);
  if (flaky) {
    const marker = path.join(os.tmpdir(), `cc-flaky-${flaky[1]}`);
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, '1');
      emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__ha__GetLiveContext', input: {} }] } });
      emit({
        type: 'result', subtype: 'error', is_error: true, result: 'transient blip', num_turns: 2,
      });
      process.exit(0);
    }
    fs.rmSync(marker, { force: true }); // recovered — fall through to a normal success
  }
  finish(prompt, wantsProposal);
}

function finish(prompt, wantsProposal) {
  const haId = 'toolu_ha_glc';
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: haId, name: 'mcp__ha__GetLiveContext', input: {} }] } });
  // The tool RESULT — is_error only when MCPERR is present (MCP unreachable case),
  // so mcpConnected can be proven up (default) or down (MCPERR).
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: haId, is_error: prompt.includes('MCPERR'), content: 'ha state' }] } });

  // Secret-SHAPED but fake: the redactor matches them by shape, while the
  // 'EXAMPLE' marker tells the repo secret-scanner they are intentional fakes.
  const jwt = 'eyJEXAMPLEheaderPart.eyJEXAMPLEbodyPart.EXAMPLEsignature';
  const apiKey = 'sk-ant-api03-EXAMPLEdeadbeefdeadbeef01';
  let proposal = null;
  if (wantsProposal && prompt.includes('PROPOSE')) {
    proposal = prompt.includes('BADINTENT')
      ? { summary: 'bad', intents: [{ intent: 'DropTables', targets: ['switch.heater'] }] }
      : {
        // summary AND intents[].data carry secret-shaped values so the test can
        // prove deep redaction reaches every field of the proposal.
        summary: `Turn off the heater; token ${jwt}`,
        intents: [{
          intent: 'HassTurnOff',
          targets: ['switch.heater'],
          data: { note: `leak ${apiKey} and ${jwt}` },
          // The model's risk hint. Omitted unless the prompt asks for LOWRISK, so
          // the default-to-"sensitive" path is exercised by the plain PROPOSE.
          ...(prompt.includes('LOWRISK') ? { risk: 'low' } : {}),
        }],
      };
  }

  // The system prompt the server threaded in via --append-system-prompt. Read
  // once here so the edit-automation echo below and the language/voice reflection
  // further down can both inspect it.
  const sysIdx = args.indexOf('--append-system-prompt');
  const sysPrompt = sysIdx !== -1 ? args[sysIdx + 1] : '';

  // A MKAUTO prompt makes the model draft an automation config. BADAUTO makes
  // it malformed so the test can prove validateAutomationDraft rejects it. The
  // valid draft carries secret-shaped values in alias + an action's data so the
  // test proves redactDeep reaches every field of the automation too.
  let automation;
  if (wantsProposal && sysPrompt.includes('MODIFYING an EXISTING')) {
    // Edit mode: the server embedded the EXISTING automation's config in the
    // system prompt. Echo its alias back through the SAME automation field so a
    // test can prove the current config actually reached the model.
    const existingAlias = ((sysPrompt.match(/"alias"\s*:\s*"([^"]+)"/)) || [])[1] || 'edited automation';
    automation = {
      alias: existingAlias,
      triggers: [{ trigger: 'state', entity_id: 'person.me', to: 'home' }],
      actions: [{ action: 'light.turn_on', target: { entity_id: 'light.living_room' } }],
      mode: 'single',
    };
  } else if (wantsProposal && prompt.includes('MKAUTO')) {
    automation = prompt.includes('BADAUTO')
      ? { alias: '', triggers: 'not-an-array', actions: [] }
      : {
        alias: `Evening lights ${jwt}`,
        description: 'turn on the living room lights when I get home in the evening',
        triggers: [{ trigger: 'state', entity_id: 'person.me', to: 'home' }],
        conditions: [{ condition: 'time', after: '17:00:00' }],
        // DEEPAUTO buries a secret past the redactor's tree-walk depth cap inside a
        // choose/sequence chain, to prove deep config blocks are still redacted.
        actions: [prompt.includes('DEEPAUTO')
          ? (() => {
            let deep = { action: 'notify.notify', data: { message: `deep ${apiKey}` } };
            for (let i = 0; i < 12; i += 1) deep = { choose: [{ conditions: [], sequence: [deep] }] };
            return deep;
          })()
          : {
            action: 'light.turn_on',
            target: { entity_id: 'light.living_room' },
            data: { note: `leak ${apiKey}` },
          }],
        mode: 'single',
      };
  }

  // LONGSTREAM pads the answer well past the server's stream safety window so a
  // test can observe genuine mid-generation deltas (not just a single tail flush).
  const filler = prompt.includes('LONGSTREAM') ? ` ${'lorem ipsum dolor '.repeat(18)}` : '';
  // Reflect the language subtag the server threaded into --append-system-prompt,
  // so a test can prove the model is told which language to answer in.
  const sysLang = ((sysPrompt.match(/language is "([^"]+)"/)) || [])[1] || '';
  // Reflect whether the voice-brevity directive was appended (surface=voice).
  const sysVoice = sysPrompt.includes('spoken aloud') ? 1 : 0;
  // Reflect whether the modify-existing-automation directive was appended
  // (edit_automation present), so a test can prove it is absent on ordinary reads.
  const sysEdit = sysPrompt.includes('MODIFYING an EXISTING') ? 1 : 0;
  // Reflect the --model the server chose (voice turns get the faster voice model).
  const mIdx = args.indexOf('--model');
  const usedModel = mIdx !== -1 ? args[mIdx + 1] : '';
  const structured = wantsProposal
    ? { text: `answer includes ${apiKey} and ${jwt}; history=${prompt.includes('Earlier in this conversation')}; vision=${prompt.includes('camera snapshot has been saved')}${filler}; syslang=${sysLang}; voice=${sysVoice}; edit=${sysEdit}; model=${usedModel}`, proposal, automation: automation || null }
    // write mode: reflect what actually reached the child via stdin, so the test
    // can prove the untrusted client prompt is absent and the intents present.
    : { text: `stdin_has_inject=${prompt.includes('INJECTED')} stdin_has_intent=${prompt.includes('HassTurnOff')}` };

  // Fine-grained streaming: when --include-partial-messages is on, emit the
  // StructuredOutput tool input as input_json_delta fragments (wrapped under
  // 'stream_event', exactly as the real CLI does) so the server's onText path
  // is exercised. The final `result` below remains the authoritative payload.
  if (args.includes('--include-partial-messages')) {
    const wrap = (event) => emit({ type: 'stream_event', event });
    wrap({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'StructuredOutput', input: {} } });
    const full = JSON.stringify(structured);
    for (let i = 0; i < full.length; i += 17) {
      wrap({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: full.slice(i, i + 17) } });
    }
    wrap({ type: 'content_block_stop', index: 1 });
  }

  emit({
    type: 'result', subtype: 'success', is_error: false,
    result: JSON.stringify(structured), structured_output: structured,
    num_turns: 2, total_cost_usd: 0.0123,
  });
  process.exit(0);
}
