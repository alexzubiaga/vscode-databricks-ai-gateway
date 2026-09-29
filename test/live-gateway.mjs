// Live check: constructs the Anthropic client exactly as src/provider.ts does and
// exercises streaming text + a tool call against the real gateway.
// Usage: <token-producing-command> | node test/live-gateway.mjs <workspace-url>
// The token arrives on stdin so it never appears in the process list or on disk.
import Anthropic from '@anthropic-ai/sdk';

const workspace = (process.argv[2] ?? '').replace(/\/+$/, '');
const token = await new Promise((resolve, reject) => {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
  });
  process.stdin.on('end', () => resolve(buffer.trim()));
  process.stdin.on('error', reject);
});
if (!token || !workspace) {
  console.error('Usage: <token-command> | node test/live-gateway.mjs <workspace-url>');
  process.exit(2);
}

const client = new Anthropic({
  baseURL: `${workspace}/ai-gateway/anthropic`,
  authToken: token,
  apiKey: null,
  defaultHeaders: { 'x-databricks-use-coding-agent-mode': 'true' },
  maxRetries: 2,
  timeout: 600000,
});

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// 1. Model listing through the SDK's raw client.
const models = await client.get('/v1/models');
const claude = models.data.filter((m) => m.id.includes('claude'));
check('model listing via SDK', claude.length > 0, `${claude.length} claude models`);

// 2. Streaming text, relayed the way StreamRelay does.
let text = '';
const stream = client.messages.stream({
  model: 'system.ai.claude-haiku-4-5',
  max_tokens: 64,
  messages: [{ role: 'user', content: 'Reply with exactly: stream ok' }],
});
for await (const event of stream) {
  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
    text += event.delta.text;
  }
}
check('streaming text_delta', text.toLowerCase().includes('stream ok'), JSON.stringify(text));

// 3. Tool call: verify content_block_start + input_json_delta + content_block_stop
//    carry everything StreamRelay needs to rebuild the input object.
const pending = new Map();
const emitted = [];
const toolStream = client.messages.stream({
  model: 'system.ai.claude-haiku-4-5',
  max_tokens: 256,
  tools: [
    {
      name: 'get_weather',
      description: 'Get the current weather for a city.',
      input_schema: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City name' } },
        required: ['city'],
      },
    },
  ],
  tool_choice: { type: 'auto' },
  messages: [{ role: 'user', content: 'What is the weather in Wuppertal? Use the tool.' }],
});
for await (const event of toolStream) {
  if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
    pending.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: '' });
  } else if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
    const p = pending.get(event.index);
    if (p) p.json += event.delta.partial_json;
  } else if (event.type === 'content_block_stop') {
    const p = pending.get(event.index);
    if (p) {
      pending.delete(event.index);
      emitted.push({ ...p, parsed: JSON.parse(p.json.trim() || '{}') });
    }
  }
}
check('tool_use streamed and reassembled', emitted.length === 1, JSON.stringify(emitted));
check(
  'tool input parsed to an object with the expected field',
  emitted.length === 1 && typeof emitted[0].parsed.city === 'string',
  emitted.length ? JSON.stringify(emitted[0].parsed) : 'no tool call',
);
check('tool callId present', emitted.length === 1 && /^toolu|^[A-Za-z0-9_-]+$/.test(emitted[0].id ?? ''), emitted[0]?.id);

// 4. Multi-turn with a tool_result block, the shape toContentBlocks builds.
if (emitted.length === 1) {
  const followUp = await client.messages.create({
    model: 'system.ai.claude-haiku-4-5',
    max_tokens: 128,
    tools: [
      {
        name: 'get_weather',
        description: 'Get the current weather for a city.',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'What is the weather in Wuppertal? Use the tool.' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: emitted[0].id, name: emitted[0].name, input: emitted[0].parsed }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: emitted[0].id, content: [{ type: 'text', text: '11C and raining' }] }] },
    ],
  });
  const reply = followUp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  check('tool_result round trip accepted', /11|rain/i.test(reply), JSON.stringify(reply.slice(0, 120)));
}

// 5. A bad token must surface as a 401/403 APIError so our retry path triggers.
const badClient = new Anthropic({
  baseURL: `${workspace}/ai-gateway/anthropic`,
  authToken: 'not-a-real-token',
  apiKey: null,
  maxRetries: 0,
});
try {
  await badClient.messages.create({
    model: 'system.ai.claude-haiku-4-5',
    max_tokens: 8,
    messages: [{ role: 'user', content: 'hi' }],
  });
  check('invalid token rejected', false, 'request unexpectedly succeeded');
} catch (error) {
  const status = error instanceof Anthropic.APIError ? error.status : undefined;
  check('invalid token surfaces as APIError 401/403', status === 401 || status === 403, `status=${status}`);
}

console.log(failures === 0 ? '\nAll live gateway checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
