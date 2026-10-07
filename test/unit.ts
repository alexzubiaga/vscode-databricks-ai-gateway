import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { accountLabel } from '../src/authProvider';
import { ConfigurationError, accountAuthorizeUrl, anthropicBaseUrl, readConfig, requireWorkspaceOrigin, validateConfig } from '../src/config';
import {
  discoverModels,
  gatewayModelId,
  isOneMVariant,
  sortModels,
  supportsOneMContext,
  withOneMVariants
} from '../src/models';
import { GatewayChatProvider, SessionState, toAnthropicMessages } from '../src/provider';
import { StatusSnapshot, buildStatusMenu, describeSnapshot } from '../src/statusMenu';
import { filterWorkspaces } from '../src/workspaces';

const settings = (vscode as unknown as { __settings: Map<string, unknown> }).__settings;

function setConfig(values: Record<string, unknown>): void {
  settings.clear();
  const defaults = {
    accountHost: 'https://accounts.cloud.databricks.com',
    accountId: '00000000-0000-0000-0000-000000000000',
    workspaceFilter: 'costcenter',
    redirectPort: 8020,
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    offerOneMContext: true,
    configureClaudeCodeOnSignIn: true,
    tokenServicePort: 0,
  };
  for (const [key, value] of Object.entries({ ...defaults, ...values })) {
    settings.set(key, value);
  }
}

test('config: a valid configuration passes validation', () => {
  setConfig({});
  validateConfig(readConfig());
});

test('config: a trailing slash on the account host is normalised away', () => {
  setConfig({ accountHost: 'https://accounts.cloud.databricks.com/' });
  const config = readConfig();
  assert.equal(config.accountHost, 'https://accounts.cloud.databricks.com');
  assert.equal(
    accountAuthorizeUrl(config),
    'https://accounts.cloud.databricks.com/oidc/accounts/00000000-0000-0000-0000-000000000000/v1/authorize',
  );
});

test('config: a non-https account host is rejected', () => {
  setConfig({ accountHost: 'http://accounts.cloud.databricks.com' });
  assert.throws(() => validateConfig(readConfig()), ConfigurationError);
});

test('config: a malformed account id is rejected', () => {
  setConfig({ accountId: 'not-a-uuid' });
  assert.throws(() => validateConfig(readConfig()), ConfigurationError);
});

test('config: an out-of-range redirect port is rejected', () => {
  setConfig({ redirectPort: 0 });
  assert.throws(() => validateConfig(readConfig()), ConfigurationError);
  setConfig({ redirectPort: 70000 });
  assert.throws(() => validateConfig(readConfig()), ConfigurationError);
});

test('workspace origin: a bare https host is accepted and normalised', () => {
  assert.equal(
    requireWorkspaceOrigin('https://dbc-00000000-0000.cloud.databricks.com/'),
    'https://dbc-00000000-0000.cloud.databricks.com',
  );
});

test('workspace origin: a path, query, fragment or credentials is refused', () => {
  for (const bad of [
    'https://host.example.com/some/path',
    'https://host.example.com/?a=b',
    'https://host.example.com/#frag',
    'https://user:pass@host.example.com',
    'http://host.example.com',
    'not a url',
  ]) {
    assert.throws(() => requireWorkspaceOrigin(bad), ConfigurationError, `should refuse ${bad}`);
  }
});

test('gateway base URL hangs off the workspace origin', () => {
  assert.equal(
    anthropicBaseUrl('https://dbc-1.cloud.databricks.com'),
    'https://dbc-1.cloud.databricks.com/ai-gateway/anthropic',
  );
});

test('workspace filter is case-insensitive and substring based', () => {
  const workspaces = [
    { name: 'innovation-team-aigw-CostCenter-prod', origin: 'https://a.example.com' },
    { name: 'recommender-prod', origin: 'https://b.example.com' },
  ];
  assert.deepEqual(filterWorkspaces(workspaces, 'costcenter').map((w) => w.name), [
    'innovation-team-aigw-CostCenter-prod',
  ]);
  assert.equal(filterWorkspaces(workspaces, '').length, 2);
});

test('messages: text turns map to Anthropic roles', () => {
  const { messages } = toAnthropicMessages([
    {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [new vscode.LanguageModelTextPart('hello')],
      name: undefined,
    },
    {
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [new vscode.LanguageModelTextPart('hi')],
      name: undefined,
    },
  ] as never);
  assert.deepEqual(messages, [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  ]);
});

test('messages: a leading assistant turn is dropped so the history starts with user', () => {
  const { messages } = toAnthropicMessages([
    {
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [new vscode.LanguageModelTextPart('stray')],
      name: undefined,
    },
    {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [new vscode.LanguageModelTextPart('hello')],
      name: undefined,
    },
  ] as never);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.role, 'user');
});

test('messages: empty turns are dropped rather than sent as empty content', () => {
  const { messages } = toAnthropicMessages([
    {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [new vscode.LanguageModelTextPart('')],
      name: undefined,
    },
  ] as never);
  assert.deepEqual(messages, []);
});

test('messages: tool calls and results convert to tool_use / tool_result blocks', () => {
  const { messages } = toAnthropicMessages([
    {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [new vscode.LanguageModelTextPart('weather?')],
      name: undefined,
    },
    {
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [new vscode.LanguageModelToolCallPart('toolu_1', 'get_weather', { city: 'Wuppertal' })],
      name: undefined,
    },
    {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [
        new vscode.LanguageModelToolResultPart('toolu_1', [new vscode.LanguageModelTextPart('11C')]),
      ],
      name: undefined,
    },
  ] as never);

  assert.deepEqual(messages[1]!.content, [
    { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Wuppertal' } },
  ]);
  assert.deepEqual(messages[2]!.content, [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '11C' }] },
  ]);
});

test('messages: an empty tool result still carries content, which the API requires', () => {
  const { messages } = toAnthropicMessages([
    {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [new vscode.LanguageModelToolResultPart('toolu_1', [])],
      name: undefined,
    },
  ] as never);
  const block = (messages[0]!.content as Array<{ type: string; content: unknown[] }>)[0]!;
  assert.equal(block.type, 'tool_result');
  assert.deepEqual(block.content, [{ type: 'text', text: '(no output)' }]);
});

test('messages: a png attachment becomes a base64 image block', () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const { messages } = toAnthropicMessages([
    {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [new vscode.LanguageModelDataPart(bytes, 'image/png')],
      name: undefined,
    },
  ] as never);
  assert.deepEqual(messages[0]!.content, [
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: Buffer.from(bytes).toString('base64') },
    },
  ]);
});

test('messages: an unsupported attachment type is skipped, not guessed at', () => {
  const { messages } = toAnthropicMessages([
    {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [
        new vscode.LanguageModelDataPart(new Uint8Array([0]), 'application/octet-stream'),
        new vscode.LanguageModelTextPart('still here'),
      ],
      name: undefined,
    },
  ] as never);
  assert.deepEqual(messages[0]!.content, [{ type: 'text', text: 'still here' }]);
});

test('models: strongest family first, newest version first within a family', () => {
  const ids = [
    'system.ai.claude-haiku-4-5',
    'system.ai.claude-opus-4-5',
    'system.ai.claude-sonnet-5',
    'system.ai.claude-opus-5',
    'system.ai.claude-sonnet-4-6',
    'system.ai.claude-opus-4-8',
  ];
  const sorted = sortModels(ids.map((id) => ({ id, displayName: id })));
  assert.deepEqual(
    sorted.map((model) => model.id),
    [
      'system.ai.claude-opus-5',
      'system.ai.claude-opus-4-8',
      'system.ai.claude-opus-4-5',
      'system.ai.claude-sonnet-5',
      'system.ai.claude-sonnet-4-6',
      'system.ai.claude-haiku-4-5',
    ],
  );
});

test('models: only the allowlisted models take the [1m] suffix', () => {
  for (const id of [
    'system.ai.claude-opus-4-6',
    'system.ai.claude-opus-4-7',
    'system.ai.claude-opus-4-8',
    'system.ai.claude-opus-5',
    'system.ai.claude-sonnet-4-6',
    'system.ai.claude-sonnet-5',
    'system.ai.claude-fable-5',
    'system.ai.claude-fable-5-1',
    'claude-opus-5',
    'SYSTEM.AI.CLAUDE-OPUS-5',
    'system.ai.claude-opus-5[1m]',
  ]) {
    assert.equal(supportsOneMContext(id), true, `${id} should support the 1M window`);
  }
  for (const id of [
    'system.ai.claude-haiku-4-5',
    'system.ai.claude-opus-4-5',
    'system.ai.claude-sonnet-4-5',
    'system.ai.claude-opus-9',
    '',
  ]) {
    assert.equal(supportsOneMContext(id), false, `${id} should not support the 1M window`);
  }
});

test('models: a 1M variant is synthesized only for compatible models', () => {
  const expanded = withOneMVariants([
    { id: 'system.ai.claude-opus-5', displayName: 'Claude Opus 5' },
    { id: 'system.ai.claude-haiku-4-5', displayName: 'Claude Haiku 4.5' },
  ]);
  assert.deepEqual(
    expanded.map((model) => [model.id, model.displayName, model.maxInputTokens, model.maxOutputTokens]),
    [
      ['system.ai.claude-opus-5', 'Claude Opus 5', undefined, undefined],
      ['system.ai.claude-opus-5[1m]', 'Claude Opus 5 (1M context)', 872000, 128000],
      ['system.ai.claude-haiku-4-5', 'Claude Haiku 4.5', undefined, undefined],
    ],
  );
});

test('models: an id the gateway already reports as [1m] is labelled, not doubled', () => {
  const expanded = withOneMVariants([
    { id: 'system.ai.claude-opus-5[1m]', displayName: 'Claude Opus 5 1m' },
  ]);
  assert.equal(expanded.length, 1);
  assert.deepEqual(
    [expanded[0]!.maxInputTokens, expanded[0]!.maxOutputTokens],
    [872000, 128000],
  );
});

test('models: the [1m] suffix does not disturb version ordering', () => {
  const sorted = sortModels(
    withOneMVariants(
      [
        'system.ai.claude-haiku-4-5',
        'system.ai.claude-opus-4-8',
        'system.ai.claude-opus-5',
        'system.ai.claude-sonnet-5',
      ].map((id) => ({ id, displayName: id })),
    ),
  );
  assert.deepEqual(
    sorted.map((model) => model.id),
    [
      // Each variant sits directly behind the model it widens, and the trailing
      // "1" in "[1m]" must not be read as a version number.
      'system.ai.claude-opus-5',
      'system.ai.claude-opus-5[1m]',
      'system.ai.claude-opus-4-8',
      'system.ai.claude-opus-4-8[1m]',
      'system.ai.claude-sonnet-5',
      'system.ai.claude-sonnet-5[1m]',
      'system.ai.claude-haiku-4-5',
    ],
  );
});

test('models: the real gateway list sorts with Opus 5 first', () => {
  // The nine models the live gateway reported during development.
  const ids = [
    'system.ai.claude-haiku-4-5',
    'system.ai.claude-opus-4-5',
    'system.ai.claude-opus-4-6',
    'system.ai.claude-opus-4-7',
    'system.ai.claude-opus-4-8',
    'system.ai.claude-opus-5',
    'system.ai.claude-sonnet-4-5',
    'system.ai.claude-sonnet-4-6',
    'system.ai.claude-sonnet-5',
  ];
  const sorted = sortModels(ids.map((id) => ({ id, displayName: id })));
  assert.equal(sorted[0]!.id, 'system.ai.claude-opus-5');
  assert.equal(sorted.at(-1)!.id, 'system.ai.claude-haiku-4-5');
  assert.equal(sorted.length, 9);
});

// ---------------------------------------------------------------------------
// 1M-context entries. The gateway serves the wider window on the *base* model id
// behind a beta flag: every `[1m]`-suffixed spelling 404s. So the suffix is a
// local label, and these tests pin that it never reaches the gateway.
// ---------------------------------------------------------------------------

const PROBE_ORIGIN = 'https://dbc-00000000-0000.cloud.databricks.com';

/** Stands in for the gateway's `/v1/models`, recording every id requested. */
function gatewayStub(options: { models?: string[] }): {
  requested: string[];
  restore: () => void;
} {
  const models = options.models ?? [
    'system.ai.claude-opus-5',
    'system.ai.claude-sonnet-5',
    'system.ai.claude-haiku-4-5',
  ];
  const requested: string[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
    requested.push(String(body.model));
    throw new Error(`discovery must not send completions, got ${url}`);
  }) as typeof globalThis.fetch;

  return { requested, restore: () => { globalThis.fetch = original; } };
}

const probeAuth = { getAccessToken: async () => 'test-token', invalidate: () => undefined };

test('models: discovery spends no completion requests on the 1M entries', async () => {
  setConfig({});
  const stub = gatewayStub({});
  try {
    const discovered = await discoverModels(probeAuth as never, PROBE_ORIGIN);
    assert.deepEqual(discovered.map((model) => model.id), [
      'system.ai.claude-opus-5',
      'system.ai.claude-opus-5[1m]',
      'system.ai.claude-sonnet-5',
      'system.ai.claude-sonnet-5[1m]',
      'system.ai.claude-haiku-4-5',
    ]);
    assert.deepEqual(stub.requested, [], 'the suffix is local, so nothing needs probing');
  } finally {
    stub.restore();
  }
});

test('models: the [1m] suffix is stripped before an id reaches the gateway', () => {
  // Every suffixed spelling 404s on the real gateway, so only the base id is sent.
  assert.equal(gatewayModelId('system.ai.claude-opus-5[1m]'), 'system.ai.claude-opus-5');
  assert.equal(gatewayModelId('system.ai.claude-opus-5'), 'system.ai.claude-opus-5');
  assert.equal(isOneMVariant('system.ai.claude-opus-5[1m]'), true);
  assert.equal(isOneMVariant('system.ai.claude-opus-5'), false);
});

test('models: offerOneMContext false keeps the 1M entries out of the picker', async () => {
  setConfig({ offerOneMContext: false });
  const stub = gatewayStub({});
  try {
    const discovered = await discoverModels(probeAuth as never, PROBE_ORIGIN);
    assert.ok(!discovered.some((model) => /\[1m\]$/.test(model.id)));
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// OAuth redirect validation. This is the check that stops a restored browser tab
// from completing an older sign-in challenge, so it is worth covering directly.
// ---------------------------------------------------------------------------

test('oauth: PKCE challenge is the base64url SHA-256 of the verifier', async () => {
  const crypto = await import('node:crypto');
  const { createPkce } = await import('../src/oauth');
  const pkce = createPkce();
  assert.match(pkce.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    pkce.challenge,
    crypto.createHash('sha256').update(pkce.verifier).digest('base64url'),
  );
});

test('oauth: two PKCE pairs never repeat', async () => {
  const { createPkce } = await import('../src/oauth');
  assert.notEqual(createPkce().verifier, createPkce().verifier);
});

test('oauth: a redirect carrying the expected state and a code is accepted', async () => {
  const { validateRedirect } = await import('../src/oauth');
  assert.equal(validateRedirect('http://localhost:8020/?code=abc&state=S', 'S'), undefined);
  assert.equal(validateRedirect('http://127.0.0.1:8020/?code=abc&state=S', 'S'), undefined);
});

test('oauth: a redirect from an older attempt is refused on the state mismatch', async () => {
  const { validateRedirect } = await import('../src/oauth');
  const message = validateRedirect('http://localhost:8020/?code=abc&state=OLD', 'NEW');
  assert.match(String(message), /older sign-in/i);
});

test('oauth: a redirect pointing off-box is refused', async () => {
  const { validateRedirect } = await import('../src/oauth');
  assert.match(String(validateRedirect('https://evil.example.com/?code=a&state=S', 'S')), /localhost/i);
});

test('oauth: a redirect with no code, an error, or junk is refused', async () => {
  const { validateRedirect } = await import('../src/oauth');
  assert.match(String(validateRedirect('http://localhost:8020/?state=S', 'S')), /no authorization code/i);
  assert.match(String(validateRedirect('http://localhost:8020/?error=access_denied', 'S')), /access_denied/);
  assert.match(String(validateRedirect('not a url', 'S')), /not a URL/i);
  assert.match(String(validateRedirect('   ', 'S')), /Paste the URL/i);
});

// ---------------------------------------------------------------------------
// Loopback token service. Claude Code's helper is the only consumer, so the
// authorization gate and the failure paths matter more than the happy path.
// ---------------------------------------------------------------------------

test('token service: gates on the shared secret and reports auth failures', async () => {
  const { TokenService } = await import('../src/tokenService');

  let mode: 'ok' | 'fail' = 'ok';
  const fakeAuth = {
    getAccessToken: async () => {
      if (mode === 'fail') {
        throw new Error('not signed in');
      }
      return 'test-access-token';
    },
  };

  const service = new TokenService(fakeAuth as never);
  await service.start(0);
  try {
    const endpoint = service.endpoint;
    assert.ok(endpoint, 'endpoint should be published once listening');
    const secret = service.sharedSecret;
    assert.match(endpoint!, /^http:\/\/127\.0\.0\.1:\d+\/token$/);

    const authorized = { Authorization: `Bearer ${secret}` };

    const good = await fetch(endpoint!, { headers: authorized });
    assert.equal(good.status, 200);
    assert.equal(await good.text(), 'test-access-token');

    const noHeader = await fetch(endpoint!);
    assert.equal(noHeader.status, 401);

    const wrongSecret = await fetch(endpoint!, { headers: { Authorization: 'Bearer nope' } });
    assert.equal(wrongSecret.status, 401);

    // A secret of the right length but wrong value must still be refused.
    const sameLength = await fetch(endpoint!, {
      headers: { Authorization: `Bearer ${'x'.repeat(secret.length)}` },
    });
    assert.equal(sameLength.status, 401);

    const base = endpoint!.replace(/\/token$/, '');
    assert.equal((await fetch(`${base}/other`, { headers: authorized })).status, 404);
    assert.equal(
      (await fetch(endpoint!, { method: 'POST', headers: authorized })).status,
      405,
    );

    // When no Databricks credential is available the helper must get a clear 503
    // rather than an empty 200 that Claude Code would use as a token.
    mode = 'fail';
    const unavailable = await fetch(endpoint!, { headers: authorized });
    assert.equal(unavailable.status, 503);
    assert.match(await unavailable.text(), /sign in/i);
  } finally {
    service.dispose();
  }
});

test('token service: publishes no endpoint before it starts or after disposal', async () => {
  const { TokenService } = await import('../src/tokenService');
  const service = new TokenService({ getAccessToken: async () => 't' } as never);
  assert.equal(service.endpoint, undefined);
  await service.start(0);
  assert.ok(service.endpoint);
  service.dispose();
  assert.equal(service.endpoint, undefined);
});

// ---------------------------------------------------------------------------
// Claude settings merge. This writes to a file the user owns and which commonly
// holds unrelated configuration, so preservation and backup are the contract.
// ---------------------------------------------------------------------------

async function withTempSettings(
  initial: string | undefined,
  body: (settingsPath: string) => Promise<void>,
): Promise<void> {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aigw-settings-'));
  const settingsPath = path.join(dir, 'settings.json');
  if (initial !== undefined) {
    await fs.writeFile(settingsPath, initial);
  }
  try {
    await body(settingsPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function readSettings(settingsPath: string): Promise<Record<string, unknown>> {
  const fs = await import('node:fs/promises');
  return JSON.parse(await fs.readFile(settingsPath, 'utf8')) as Record<string, unknown>;
}

test('claude settings: unrelated keys and env vars survive the merge', async () => {
  const { mergeClaudeSettings } = await import('../src/claudeCode');
  const initial = JSON.stringify({
    model: 'some-model',
    permissions: { allow: ['Bash(ls)'] },
    env: { MY_OWN_VAR: 'keep-me' },
  });
  await withTempSettings(initial, async (settingsPath) => {
    const result = await mergeClaudeSettings(settingsPath, 'https://ws/ai-gateway/anthropic', '/h/helper.sh');
    const settings = await readSettings(settingsPath);

    assert.equal(settings['model'], 'some-model');
    assert.deepEqual(settings['permissions'], { allow: ['Bash(ls)'] });
    const env = settings['env'] as Record<string, string>;
    assert.equal(env['MY_OWN_VAR'], 'keep-me');
    assert.equal(env['ANTHROPIC_BASE_URL'], 'https://ws/ai-gateway/anthropic');
    assert.equal(env['CLAUDE_CODE_API_KEY_HELPER_TTL_MS'], '900000');
    assert.equal(settings['apiKeyHelper'], '/h/helper.sh');
    assert.ok(result.backupPath, 'an existing file must be backed up');
  });
});

test('claude settings: the backup holds the pre-merge contents', async () => {
  const { mergeClaudeSettings } = await import('../src/claudeCode');
  const initial = JSON.stringify({ model: 'original' });
  await withTempSettings(initial, async (settingsPath) => {
    const result = await mergeClaudeSettings(settingsPath, 'https://ws/ai-gateway/anthropic', '/h/helper.sh');
    assert.deepEqual(await readSettings(result.backupPath!), { model: 'original' });
  });
});

test('claude settings: a missing file is created without a backup', async () => {
  const { mergeClaudeSettings } = await import('../src/claudeCode');
  await withTempSettings(undefined, async (settingsPath) => {
    const result = await mergeClaudeSettings(settingsPath, 'https://ws/ai-gateway/anthropic', '/h/helper.sh');
    assert.equal(result.backupPath, undefined);
    assert.equal(
      (await readSettings(settingsPath))['apiKeyHelper'],
      '/h/helper.sh',
    );
  });
});

test('claude settings: malformed JSON aborts the write instead of replacing the file', async () => {
  const fs = await import('node:fs/promises');
  const { mergeClaudeSettings } = await import('../src/claudeCode');
  const broken = '{ "model": "x",, }';
  await withTempSettings(broken, async (settingsPath) => {
    await assert.rejects(
      () => mergeClaudeSettings(settingsPath, 'https://ws/ai-gateway/anthropic', '/h/helper.sh'),
      /not valid JSON/i,
    );
    // The user's file must be exactly as it was.
    assert.equal(await fs.readFile(settingsPath, 'utf8'), broken);
  });
});

test('claude settings: revert removes only the managed keys', async () => {
  const { mergeClaudeSettings, revertClaudeSettings } = await import('../src/claudeCode');
  const initial = JSON.stringify({ model: 'keep', env: { MY_OWN_VAR: 'keep-me' } });
  await withTempSettings(initial, async (settingsPath) => {
    const helper = process.platform === 'win32'
      ? '/h/databricks-aigw-token.cmd'
      : '/h/databricks-aigw-token.sh';
    await mergeClaudeSettings(settingsPath, 'https://ws/ai-gateway/anthropic', helper);
    await revertClaudeSettings(settingsPath);

    const settings = await readSettings(settingsPath);
    assert.equal(settings['model'], 'keep');
    assert.equal(settings['apiKeyHelper'], undefined);
    assert.deepEqual(settings['env'], { MY_OWN_VAR: 'keep-me' });
  });
});

test('claude settings: revert leaves a hand-written apiKeyHelper alone', async () => {
  const { revertClaudeSettings } = await import('../src/claudeCode');
  const initial = JSON.stringify({ apiKeyHelper: '/opt/my-own-helper.sh', env: { ANTHROPIC_BASE_URL: 'https://ws' } });
  await withTempSettings(initial, async (settingsPath) => {
    await revertClaudeSettings(settingsPath);
    const settings = await readSettings(settingsPath);
    assert.equal(settings['apiKeyHelper'], '/opt/my-own-helper.sh');
    // Our env key still goes, and the now-empty env object is dropped.
    assert.equal(settings['env'], undefined);
  });
});

test('claude settings: revert on a missing file is a no-op', async () => {
  const { revertClaudeSettings } = await import('../src/claudeCode');
  await withTempSettings(undefined, async (settingsPath) => {
    await revertClaudeSettings(settingsPath);
  });
});

const SIGNED_OUT: StatusSnapshot = {
  signedIn: false,
  claudeSettingsPath: '/home/dev/.claude/settings.json',
  claudeCodeConfigured: false,
};

const SIGNED_IN: StatusSnapshot = {
  signedIn: true,
  accountLabel: 'dev@example.com',
  workspaceName: 'costcenter-prod',
  workspaceOrigin: 'https://dbc-1234.cloud.databricks.com',
  models: [
    { id: 'claude-opus-5', displayName: 'Claude Opus 5' },
    { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' },
  ],
  claudeSettingsPath: '/home/dev/.claude/settings.json',
  claudeCodeConfigured: true,
  tokenServiceEndpoint: 'http://127.0.0.1:41234',
};

/** Action kinds offered by a menu, separators dropped. */
function actionKinds(snapshot: StatusSnapshot): string[] {
  return buildStatusMenu(snapshot)
    .map((item) => item.action?.kind)
    .filter((kind): kind is string => kind !== undefined);
}

test('menu: signed out offers sign-in and never sign-out or a model list', () => {
  const items = buildStatusMenu(SIGNED_OUT);
  const kinds = actionKinds(SIGNED_OUT);
  assert.ok(kinds.includes('signIn'));
  assert.ok(!kinds.includes('signOut'));
  assert.equal(describeSnapshot(SIGNED_OUT), 'Not signed in');
});

test('menu: signed in lists every model and offers sign-out', () => {
  const items = buildStatusMenu(SIGNED_IN);
  const modelRows = items.filter((item) => item.action?.kind === 'copyModelId');
  assert.deepEqual(
    modelRows.map((item) => item.description),
    ['claude-opus-5', 'claude-sonnet-5'],
  );
  const kinds = actionKinds(SIGNED_IN);
  assert.ok(kinds.includes('signOut'));
  assert.ok(!kinds.includes('signIn'));
  assert.ok(items.some((item) => item.label.startsWith('Models (2)')));
  assert.equal(describeSnapshot(SIGNED_IN), 'costcenter-prod — 2 Claude model(s)');
});

test('menu: every non-separator row is either actionable or plainly informational', () => {
  for (const snapshot of [SIGNED_OUT, SIGNED_IN]) {
    for (const item of buildStatusMenu(snapshot)) {
      if (item.kind === vscode.QuickPickItemKind.Separator) {
        assert.equal(item.action, undefined);
        continue;
      }
      // A row that advertises what picking it does must actually do something.
      if (item.detail) {
        assert.ok(item.action, `"${item.label}" has a detail hint but no action`);
      }
    }
  }
});

test('menu: the Claude Code row writes the wiring when absent and opens it when present', () => {
  const configured = buildStatusMenu(SIGNED_IN).find((item) => item.label.includes('Claude Code'));
  assert.equal(configured?.action?.kind, 'openClaudeSettings');
  const missing = buildStatusMenu({ ...SIGNED_IN, claudeCodeConfigured: false }).find((item) =>
    item.label.includes('Claude Code'),
  );
  assert.equal(missing?.action?.kind, 'configureClaudeCode');
});

test('menu: signed in with no workspace steers to workspace selection, not discovery', () => {
  const snapshot: StatusSnapshot = {
    signedIn: true,
    claudeSettingsPath: '/home/dev/.claude/settings.json',
    claudeCodeConfigured: false,
  };
  const kinds = actionKinds(snapshot);
  assert.ok(kinds.includes('selectWorkspace'));
  assert.ok(!kinds.includes('discoverModels'));
  assert.equal(describeSnapshot(snapshot), 'Signed in — no workspace selected');
});

test('menu: a resolved workspace with no models offers discovery', () => {
  const snapshot: StatusSnapshot = { ...SIGNED_IN, models: undefined };
  assert.ok(actionKinds(snapshot).includes('discoverModels'));
  assert.equal(describeSnapshot(snapshot), 'costcenter-prod — models not discovered yet');
});

test('account label: the email claim of the access token is preferred', () => {
  const payload = Buffer.from(
    JSON.stringify({ sub: '1f2e-uuid', email: 'dev@example.com' }),
  ).toString('base64url');
  assert.equal(accountLabel(`header.${payload}.signature`), 'dev@example.com');
});

test('account label: falls back to sub, then to a generic label', () => {
  const subOnly = Buffer.from(JSON.stringify({ sub: 'dev@example.com' })).toString('base64url');
  assert.equal(accountLabel(`header.${subOnly}.signature`), 'dev@example.com');
  assert.equal(accountLabel('not-a-jwt'), 'Databricks account');
  assert.equal(accountLabel('header.bm90IGpzb24.signature'), 'Databricks account');
  assert.equal(accountLabel(''), 'Databricks account');
});

// --- the model list VS Code sees ----------------------------------------------
//
// VS Code caches whatever `provideLanguageModelChatInformation` returns and only
// asks again when the change event fires, so an empty list returned for a passing
// failure is what takes the models out of the Copilot chat picker for good.

const SESSION: SessionState = {
  workspaceOrigin: 'https://costcenter-prod.cloud.databricks.com',
  workspaceName: 'costcenter-prod',
  models: [{ id: 'system.ai.claude-opus-5', displayName: 'Claude Opus 5' }],
};

const NO_TOKEN_OPTIONS = {} as unknown as vscode.CancellationToken;

/** A provider whose resolve outcome the test flips between calls. */
function harness(options: { signedIn?: boolean } = {}) {
  let resolve: () => Promise<SessionState | undefined> = async () => SESSION;
  let session: SessionState | undefined;
  // Only `hasStoredCredential` is reached on the listing path; the rest of
  // AuthManager belongs to the request path, which these tests do not exercise.
  const auth = { hasStoredCredential: async () => options.signedIn ?? true };
  const provider = new GatewayChatProvider(
    auth as never,
    () => session,
    async () => {
      session = await resolve();
      return session;
    },
  );
  return {
    provider,
    list: () => provider.provideLanguageModelChatInformation({ silent: true }, NO_TOKEN_OPTIONS),
    succeed: () => {
      resolve = async () => SESSION;
    },
    fail: () => {
      session = undefined;
      resolve = async () => {
        throw new Error('the gateway is unreachable');
      };
    },
    resolveToNothing: () => {
      session = undefined;
      resolve = async () => undefined;
    },
  };
}

test('models: a failing resolve replays the last good list instead of emptying the picker', async () => {
  setConfig({});
  const h = harness();
  const first = await h.list();
  assert.deepEqual(first.map((model) => model.id), ['system.ai.claude-opus-5']);

  h.fail();
  const afterFailure = await h.list();
  assert.deepEqual(
    afterFailure.map((model) => model.id),
    ['system.ai.claude-opus-5'],
    'a transient gateway failure must not remove the models from the picker',
  );
  h.provider.dispose();
});

test('models: an unresolved session replays too, rather than reporting none', async () => {
  setConfig({});
  const h = harness();
  await h.list();

  h.resolveToNothing();
  const replayed = await h.list();
  assert.equal(replayed.length, 1);
  h.provider.dispose();
});

test('models: nothing is replayed before a first successful listing', async () => {
  setConfig({});
  const h = harness();
  h.fail();
  assert.deepEqual(await h.list(), []);
  h.provider.dispose();
});

test('models: reset forgets the replay cache, so a sign-out really clears the picker', async () => {
  setConfig({});
  const h = harness();
  await h.list();

  h.provider.reset();
  h.fail();
  assert.deepEqual(await h.list(), [], 'sign-out must not leave stale models selectable');
  h.provider.dispose();
});

test('models: a base entry declares the configured context window', async () => {
  setConfig({ maxInputTokens: 123456 });
  const h = harness();
  const listed = await h.list();
  assert.equal(listed[0]?.maxInputTokens, 123456);
  h.provider.dispose();
});
