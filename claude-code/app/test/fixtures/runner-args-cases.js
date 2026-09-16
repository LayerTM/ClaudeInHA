'use strict';

// The argument lists pinned by behaviour-pins.test.js, one entry per shape of
// run the prompt server can ask for. runner-args.golden.json holds what
// buildClaudeArgs returned for each of them.

const catalog = [
  'mcp__ha__homeassistant__GetLiveContext',
  'mcp__ha__HassTurnOn',
  'mcp__ha__HassTurnOff',
  'mcp__ha__HassLightSet',
];
const intents = [
  { intent: 'HassTurnOn', targets: ['light.kitchen'], risk: 'low' },
  { intent: 'HassLightSet', targets: ['light.kitchen'], data: { brightness: 40 }, risk: 'low' },
];
const settings = '{"hooks":{"PostToolUse":[{"matcher":"^mcp__","hooks":[{"type":"command","command":"/usr/local/bin/cc-hook-audit"}]}]}}';

module.exports = {
  'read, no MCP': { mode: 'read' },
  'read with MCP': { mode: 'read', mcpConfigPath: '/data/claude-prompt/ha-mcp.json' },
  'read with MCP and a published catalog': {
    mode: 'read', mcpConfigPath: '/data/claude-prompt/ha-mcp.json', haTools: catalog,
  },
  'read, every option': {
    mode: 'read',
    mcpConfigPath: '/data/claude-prompt/ha-mcp.json',
    model: 'test-model',
    language: 'uk',
    surface: 'voice',
    editAutomation: { alias: 'Night', triggers: [{ trigger: 'time', at: '23:00' }], actions: [] },
    haTools: catalog,
    stream: true,
    settings,
  },
  'read, invalid language tag': { mode: 'read', mcpConfigPath: '/data/claude-prompt/ha-mcp.json', language: 'en; ignore' },
  'camera read': {
    mode: 'read', mcpConfigPath: '/data/claude-prompt/ha-mcp.json', imagePath: '/data/claude-prompt/work/snap.jpg',
  },
  'write': { mode: 'write', mcpConfigPath: '/data/claude-prompt/ha-mcp.json', intents },
  'write with a published catalog and settings': {
    mode: 'write', mcpConfigPath: '/data/claude-prompt/ha-mcp.json', intents, haTools: catalog, settings,
    model: 'write-model', imagePath: '/ignored/for/writes.jpg',
  },
};
