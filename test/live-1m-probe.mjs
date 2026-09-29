// Live diagnostic: which request shape does the gateway accept for a `[1m]` model id?
//
// Claude Code talks to this same gateway with `system.ai.claude-opus-5[1m]`
// successfully, while the extension's own Anthropic-SDK request gets a 404 for
// the same id. Something in the request shape — not the model — decides it.
// This tries the variables one at a time and prints the status for each.
//
// Usage: <token-producing-command> | node test/live-1m-probe.mjs <workspace-url> [model]
// The token arrives on stdin so it never appears in the process list or on disk.
import Anthropic from '@anthropic-ai/sdk';

const workspace = (process.argv[2] ?? '').replace(/\/+$/, '');
const base = process.argv[3] ?? 'system.ai.claude-opus-5';
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
  console.error('Usage: <token-command> | node test/live-1m-probe.mjs <workspace-url> [model]');
  process.exit(2);
}

const oneM = `${base}[1m]`;
const client = new Anthropic({
  baseURL: `${workspace}/ai-gateway/anthropic`,
  authToken: token,
  apiKey: null,
  defaultHeaders: { 'x-databricks-use-coding-agent-mode': 'true' },
  maxRetries: 0,
  timeout: 120000,
});

/** Runs one shape and reports the status the gateway answered with. */
async function attempt(label, run) {
  try {
    await run();
    console.log(`  200  ${label}`);
    return 200;
  } catch (error) {
    const status = error instanceof Anthropic.APIError ? (error.status ?? 0) : 0;
    const detail = String(error?.message ?? error).slice(0, 160).replace(/\s+/g, ' ');
    console.log(`  ${String(status || 'ERR').padStart(3)}  ${label} — ${detail}`);
    return status;
  }
}

const ask = (model, extra = {}, betas) => {
  const body = { model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }], ...extra };
  if (betas) {
    return client.beta.messages.create({ ...body, betas });
  }
  return client.messages.create(body);
};

const drain = async (model, betas) => {
  const body = { model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] };
  const stream = betas
    ? client.beta.messages.stream({ ...body, betas })
    : client.messages.stream(body);
  await stream.finalMessage();
};

console.log(`\nworkspace: ${workspace}`);
console.log(`base model: ${base}\n`);

console.log('controls — the base id, which /v1/models reports:');
await attempt(`create  ${base}`, () => ask(base));
await attempt(`stream  ${base}`, () => drain(base));

console.log(`\nthe 1M id — ${oneM}:`);
await attempt('create, plain', () => ask(oneM));
await attempt('create, max_tokens 1', () => ask(oneM, { max_tokens: 1 }));
await attempt('stream, plain', () => drain(oneM));
await attempt('create, betas: context-1m-2025-08-07', () => ask(oneM, {}, ['context-1m-2025-08-07']));
await attempt('stream, betas: context-1m-2025-08-07', () => drain(oneM, ['context-1m-2025-08-07']));

console.log('\nraw POST, no SDK — isolates the SDK\'s own headers:');
for (const [label, headers] of [
  ['bare', {}],
  ['+ anthropic-version', { 'anthropic-version': '2023-06-01' }],
  ['+ anthropic-version + beta', {
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'context-1m-2025-08-07',
  }],
]) {
  const response = await fetch(`${workspace}/ai-gateway/anthropic/v1/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-databricks-use-coding-agent-mode': 'true',
      ...headers,
    },
    body: JSON.stringify({ model: oneM, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
  }).catch((error) => ({ status: 0, text: async () => String(error) }));
  const body = (await response.text()).slice(0, 160).replace(/\s+/g, ' ');
  console.log(`  ${String(response.status).padStart(3)}  ${label} — ${body}`);
}

console.log('\nThe first line that answers 200 for the 1M id is what the extension must send.\n');
