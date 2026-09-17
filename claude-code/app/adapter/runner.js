'use strict';

// How one prompt-API request becomes a `claude -p` call, and how its stream-json
// output becomes the core's neutral events. The core (server/prompt/run.js) owns
// the request policy, the prompts and schemas, the process lifecycle and the
// outcome. The security posture of the call itself lives here:
//   - deny-by-default permissions (`dontAsk`) + the core's narrow allowlist
//   - the built-in tool set is declared, not subtracted: --tools names exactly
//     what the mode needs (nothing, or Read for a camera snapshot)
//   - --setting-sources '': none of the console's settings files (hooks,
//     plugins, per-model options) reach this child; --settings passes back
//     only what it must keep (the audit hook)
//   - --no-session-persistence: a run leaves no transcript on disk
//   - --strict-mcp-config: only OUR scoped HA MCP config is loaded, never the
//     interactive console's user-configured MCP servers
//   - the child env gets only the credential and proxy variables below; the
//     core adds its fixed base and never passes a Supervisor or HA token

// The built-in tools a run can see, declared per mode. `--tools` makes every
// other built-in unavailable, including ones a future CLI adds; the list this
// replaced subtracted known names and had already missed three (measured with
// CLI 2.1.272: ListAgents, ReadMcpResourceDirTool and ReportFindings were still
// offered). The enforcement layer is still `dontAsk`, which denies any call not
// on the per-request allowlist — so vision's `Read` is usable only on the one
// snapshot path the allowlist names.
const BUILTIN_TOOLS_READ = '';
const BUILTIN_TOOLS_VISION = 'Read';
const BUILTIN_TOOLS_WRITE = '';

// Tools of the `ha` MCP server are published as `mcp__ha__<name>`, and Home
// Assistant itself may namespace <name> (`homeassistant__GetLiveContext`; every
// tool once more than one API is selected). The core pins basenames only.
const HA_TOOL_PREFIX = 'mcp__ha__';

// `mcp__ha__homeassistant__GetLiveContext` -> `GetLiveContext`
// `mcp__ha__HassTurnOn`                    -> `HassTurnOn`
// Anything that is not an `ha` MCP tool -> null.
function toolBasename(name) {
  if (typeof name !== 'string' || !name.startsWith(HA_TOOL_PREFIX)) return null;
  const rest = name.slice(HA_TOOL_PREFIX.length);
  if (!rest) return null;
  const cut = rest.lastIndexOf('__');
  return cut === -1 ? rest : rest.slice(cut + 2);
}

// The name a basename has before any discovery.
function toolName(basename) {
  return `${HA_TOOL_PREFIX}${basename}`;
}

// Passed on from the add-on's environment when set: the CLI's credentials, the
// proxy settings, and the identity variables some credential stores need
// (e.g. macOS keychain in dev).
const PASSTHROUGH_ENV = [
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
  'USER', 'LOGNAME',
];

/**
 * The complete command line for one run spec from the core. CI hands the same
 * lists to the bundled CLI, so a flag the CLI stops accepting fails the build
 * rather than every request.
 */
function launch(spec, { env }) {
  const allowedTools = [...spec.haAllowed];
  if (spec.vision) allowedTools.push(`Read(${spec.imagePath})`);

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'dontAsk',
    '--allowed-tools', allowedTools.join(','),
    '--tools', spec.vision ? BUILTIN_TOOLS_VISION : (spec.read ? BUILTIN_TOOLS_READ : BUILTIN_TOOLS_WRITE),
    // The console's settings files are the user's interactive setup: its hooks,
    // plugins, skills and per-model options added ~1,300 tokens to every model
    // call and broke prompt caching between identical requests. This child needs
    // none of them; credentials are not a setting source and still load.
    '--setting-sources', '',
    // Each run is stateless (history travels in the prompt), so nothing is saved:
    // a saved session is a transcript of the home state the run read.
    '--no-session-persistence',
    '--json-schema', spec.schema,
    '--append-system-prompt', spec.systemPrompt,
    // Accepted (though no longer documented) by CLI 2.1.200; bounds agentic
    // loops as a second ceiling next to the wall-clock timeout.
    '--max-turns', String(spec.maxTurns),
    '--strict-mcp-config',
  ];
  if (spec.mcpConfigPath) args.push('--mcp-config', spec.mcpConfigPath);
  // What the settings files are still needed for, declared per run: the audit
  // hook that records each Home Assistant tool call WITH its arguments. The
  // allowlist gates by tool name only, so the arguments are the record.
  if (spec.settings) args.push('--settings', spec.settings);
  if (spec.model) args.push('--model', spec.model);
  // Fine-grained partial-message events only when a streaming consumer is
  // attached; without this flag stream-json emits whole messages only.
  if (spec.stream) args.push('--include-partial-messages');
  // Every `ha` tool the session publishes but this run may not call is taken out
  // of the model's context (the core lists them from the published catalog).
  if (spec.mcpConfigPath && spec.haDisallowed.length) {
    args.push('--disallowed-tools', spec.haDisallowed.join(','));
  }

  const extra = { IS_SANDBOX: '1', DISABLE_AUTOUPDATER: '1' };
  for (const key of PASSTHROUGH_ENV) {
    if (env[key]) extra[key] = env[key];
  }
  return { args, env: extra };
}

// The model the API served, as the console's own transcripts name it. The CLI
// reports a context-window variant chosen by alias with a bracketed suffix
// (`claude-opus-5[1m]`), while the messages it records carry the model alone
// (`claude-opus-5`), so the suffix is dropped and one model keeps one name.
function servedModel(name) {
  return String(name).replace(/\[[^\]]*\]$/, '');
}

// The tokens one run used, per model, from its result event. `usage` there covers
// the main model only: a run also calls a small side model, whose tokens appear
// only in `modelUsage` (measured on CLI 2.1.272: about 900 input tokens a run)
// while `total_cost_usd` includes them. So `modelUsage` is read when present.
function runTokens(envelope, initModel) {
  const n = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
  const perModel = envelope && envelope.modelUsage;
  if (perModel && typeof perModel === 'object' && Object.keys(perModel).length > 0) {
    return Object.entries(perModel).map(([modelName, u]) => ({
      model: servedModel(modelName),
      input: n(u && u.inputTokens),
      output: n(u && u.outputTokens),
      cacheRead: n(u && u.cacheReadInputTokens),
      cacheWrite: n(u && u.cacheCreationInputTokens),
    }));
  }
  const u = envelope && envelope.usage;
  if (!u || typeof u !== 'object') return [];
  return [{
    model: initModel ? servedModel(initModel) : 'unknown',
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite: n(u.cache_creation_input_tokens),
  }];
}

function contentBlocks(message) {
  return message && Array.isArray(message.content) ? message.content : [];
}

// One run's stream-json events -> the core's neutral events.
function createDecoder() {
  let initModel = '';
  return (ev) => {
    const out = [];
    // Claude Code wraps raw Anthropic stream events under type 'stream_event';
    // the structured answer streams as the StructuredOutput tool's input JSON.
    const e = ev.type === 'stream_event' && ev.event ? ev.event : ev;
    if (e && e.type === 'content_block_start') {
      out.push({ type: 'fragment-start' });
    } else if (e && e.type === 'content_block_delta' && e.delta
        && e.delta.type === 'input_json_delta' && typeof e.delta.partial_json === 'string') {
      out.push({ type: 'fragment', json: e.delta.partial_json });
    }

    if (ev.type === 'system' && ev.subtype === 'init') {
      if (typeof ev.model === 'string') initModel = ev.model;
      const servers = Array.isArray(ev.mcp_servers) ? ev.mcp_servers : [];
      out.push({
        type: 'init',
        model: typeof ev.model === 'string' ? ev.model : undefined,
        mcpConnected: servers.some((s) => s && s.name === 'ha' && s.status === 'connected'),
        // The CLI always reports its tool list; a missing one is an empty list.
        tools: Array.isArray(ev.tools) ? ev.tools : [],
      });
    } else if (ev.type === 'assistant') {
      for (const block of contentBlocks(ev.message)) {
        if (block && block.type === 'tool_use' && typeof block.name === 'string'
            // internal plumbing of --json-schema, not a real tool
            && block.name !== 'StructuredOutput') {
          out.push({ type: 'tool-use', id: block.id, name: block.name });
        }
      }
    } else if (ev.type === 'user') {
      // Tool RESULTS come back as a user message.
      for (const block of contentBlocks(ev.message)) {
        if (block && block.type === 'tool_result') {
          out.push({ type: 'tool-result', id: block.tool_use_id, isError: Boolean(block.is_error) });
        }
      }
    } else if (ev.type === 'result') {
      out.push({
        type: 'result',
        isError: Boolean(ev.is_error),
        // error_max_turns fails the same way again; other errors are transient.
        deterministic: ev.subtype === 'error_max_turns',
        structured: ev.structured_output,
        text: ev.result,
        numTurns: ev.num_turns,
        costUsd: ev.total_cost_usd,
        tokens: runTokens(ev, initModel),
      });
    }
    return out;
  };
}

module.exports = {
  launch, createDecoder, toolName, toolBasename, runTokens,
};
