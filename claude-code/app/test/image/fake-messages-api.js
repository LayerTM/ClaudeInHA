'use strict';

// A stand-in for the Messages API, so the real CLI in the image can run a turn
// without the network: the first request is answered with one tool call (name
// and input from argv), every later one ends the turn. Each request body is
// appended to the log file, which is how a pin sees the tool result.
//   node fake-messages-api.js <port> <log> <tool> <input-json>

const fs = require('node:fs');
const http = require('node:http');

const [port, log, tool, input] = process.argv.slice(2);
let calls = 0;

http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    fs.appendFileSync(log, `${req.method} ${req.url}\n${body}\n`);
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"input_tokens":1}');
      return;
    }
    calls += 1;
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    event('message_start', {
      message: {
        id: `msg_${calls}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
        content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    if (calls === 1) {
      event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: tool, input: {} } });
      event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: input } });
      event('content_block_stop', { index: 0 });
      event('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } });
    } else {
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'done' } });
      event('content_block_stop', { index: 0 });
      event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
    }
    event('message_stop', {});
    res.end();
  });
}).listen(Number(port), '127.0.0.1');
