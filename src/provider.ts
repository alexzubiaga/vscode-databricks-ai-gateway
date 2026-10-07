import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlockParam,
  MessageParam,
  MessageStreamEvent,
  Tool,
  ToolChoice,
} from '@anthropic-ai/sdk/resources/messages';
import * as vscode from 'vscode';
import { AuthManager, NotSignedInError } from './auth';
import { readConfig } from './config';
import { createGatewayClient } from './gateway';
import { log } from './log';
import { GatewayModel, ONE_M_BETA, gatewayModelId, isOneMVariant } from './models';
import { describe } from './oauth';

/**
 * Backoff for re-resolving the session after a failed model listing.
 *
 * VS Code asks for the list only when the change event fires, so a failure nobody
 * retries lasts for the rest of the window. The delays climb so a gateway that is
 * down for an afternoon is not polled every few seconds.
 */
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000];

export interface SessionState {
  workspaceOrigin: string;
  workspaceName: string;
  models: GatewayModel[];
}

/**
 * Bridges VS Code chat to the Databricks-hosted Anthropic endpoint.
 *
 * The gateway speaks the native Anthropic Messages wire format, so this
 * translates VS Code's message parts to Anthropic blocks and streams the
 * response back. No local relay process is involved.
 */
export class GatewayChatProvider implements vscode.LanguageModelChatProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

  /**
   * The last list VS Code was given, replayed when a later resolve cannot produce one.
   *
   * VS Code caches whatever this provider returns and re-reads it only when the
   * change event fires, so answering a transient failure with an empty list drops
   * the models out of the chat picker until the user runs a command by hand.
   * Replaying the last good list keeps them selectable: if the gateway really is
   * unreachable the request itself fails with a reason the user can act on, which
   * a silently empty picker never gives them.
   */
  private lastPublished: vscode.LanguageModelChatInformation[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryAttempt = 0;

  constructor(
    private readonly auth: AuthManager,
    private readonly getSession: () => SessionState | undefined,
    private readonly ensureSession: (silent: boolean) => Promise<SessionState | undefined>,
  ) {}

  dispose(): void {
    this.cancelRetry();
    this.changeEmitter.dispose();
  }

  /** Tells VS Code to re-read the model list, e.g. after a workspace switch. */
  refresh(): void {
    this.changeEmitter.fire();
  }

  /**
   * Re-reads the list and forgets the replay cache.
   *
   * For when the previous models are genuinely gone — a sign-out, an account or
   * filter change — rather than momentarily unreachable.
   */
  reset(): void {
    this.lastPublished = [];
    this.cancelRetry();
    this.changeEmitter.fire();
  }

  async provideLanguageModelChatInformation(
    options: { readonly silent: boolean },
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    let session: SessionState | undefined;
    try {
      session = await this.ensureSession(options.silent);
    } catch (error) {
      // Throwing here would surface a raw error in the model picker, so the
      // failure is logged and the previous list stands in until a retry lands.
      log.warn(`Could not resolve the gateway session: ${describe(error)}`);
      return this.standIn('the gateway session could not be resolved');
    }
    if (!session) {
      // Either nobody has signed in yet, or a silent call arrived before the
      // background resolve finished. Neither means the models went away.
      return this.standIn('no workspace is resolved yet');
    }

    this.cancelRetry();
    const config = readConfig();
    this.lastPublished = session.models.map((model) => ({
      id: model.id,
      name: model.displayName,
      family: familyOf(model.id),
      version: model.id,
      // The gateway reports 0 for both limits, so these are local declarations.
      // The `[1m]` entries carry their own limits; base models follow the settings.
      maxInputTokens: model.maxInputTokens ?? config.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens ?? config.maxOutputTokens,
      tooltip: `${model.displayName} via Databricks AI Gateway (${session.workspaceName})`,
      detail: session.workspaceName,
      capabilities: {
        toolCalling: true,
        imageInput: true,
      },
    }));
    return this.lastPublished;
  }

  /**
   * Stands in for a list that cannot be resolved right now, and arranges another
   * attempt so the picker recovers on its own instead of waiting for a command.
   */
  private standIn(reason: string): vscode.LanguageModelChatInformation[] {
    void this.scheduleRetry();
    if (this.lastPublished.length > 0) {
      log.debug(`Replaying ${this.lastPublished.length} cached model(s): ${reason}.`);
    }
    return this.lastPublished;
  }

  private async scheduleRetry(): Promise<void> {
    if (this.retryTimer) {
      return;
    }
    // Nothing to retry for someone who has not signed in: the sign-in itself
    // republishes the list.
    if (!(await this.auth.hasStoredCredential())) {
      return;
    }
    const delay = RETRY_DELAYS_MS[Math.min(this.retryAttempt, RETRY_DELAYS_MS.length - 1)]!;
    this.retryAttempt += 1;
    log.debug(`Retrying the gateway model listing in ${Math.round(delay / 1000)}s.`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.ensureSession(true)
        .then((resolved) => {
          if (!resolved) {
            void this.scheduleRetry();
            return;
          }
          log.info('The gateway session recovered; re-publishing the model list.');
          // Fires the change event, which makes VS Code ask again and refills
          // the picker without the user noticing the gap.
          this.refresh();
        })
        .catch((error: unknown) => {
          log.debug(`The gateway model listing retry failed: ${describe(error)}`);
          void this.scheduleRetry();
        });
    }, delay);
  }

  private cancelRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.retryAttempt = 0;
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    // The picker can offer a replayed model while the session is still unresolved,
    // so a request re-resolves rather than refusing. Silently: a browser window
    // thrown up in the middle of someone's chat turn is worse than a clear error.
    const session = this.getSession() ?? (await this.ensureSession(true));
    if (!session) {
      throw new Error('No Databricks AI Gateway workspace is selected. Run "Databricks AI Gateway: Sign In".');
    }
    const config = readConfig();
    const { messages: anthropicMessages } = toAnthropicMessages(messages);
    const maxOutputTokens = model.maxOutputTokens ?? config.maxOutputTokens;

    const body: Anthropic.MessageStreamParams = {
      // The `[1m]` suffix is this extension's label; the gateway serves the wider
      // window on the base id behind the beta flag added in streamOnce.
      model: gatewayModelId(model.id),
      max_tokens: clampMaxTokens(options.modelOptions?.['max_tokens'], maxOutputTokens),
      messages: anthropicMessages,
      ...toolParams(options),
    };
    applyCacheBreakpoints(body);

    await this.streamOnce(session, body, progress, token, /* allowRetry */ true, isOneMVariant(model.id));
  }

  /**
   * Issues the request and relays stream events. A 401 gets exactly one retry
   * with a freshly minted token, which covers a token expiring mid-session.
   */
  private async streamOnce(
    session: SessionState,
    body: Anthropic.MessageStreamParams,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    allowRetry: boolean,
    oneMContext = false,
  ): Promise<void> {
    const accessToken = await this.auth.getAccessToken();
    const client = this.createClient(session.workspaceOrigin, accessToken);

    const abort = new AbortController();
    const subscription = token.onCancellationRequested(() => abort.abort());
    try {
      const stream = client.messages.stream(body, {
        signal: abort.signal,
        ...(oneMContext ? { headers: { 'anthropic-beta': ONE_M_BETA } } : {}),
      });
      const relay = new StreamRelay(progress);
      let cancelled = false;
      for await (const event of stream as AsyncIterable<MessageStreamEvent>) {
        if (token.isCancellationRequested) {
          cancelled = true;
          break;
        }
        relay.handle(event);
      }
      // On cancellation the buffered fragments are meaningless; flushing them
      // would report a truncated tool call the user never asked to complete.
      if (!cancelled) {
        relay.finish();
        relay.logUsage(String(body.model));
      }
      return;
    } catch (error) {
      if (token.isCancellationRequested) {
        // Cancellation is not a failure; VS Code already knows.
        return;
      }
      if (allowRetry && isUnauthorized(error)) {
        log.debug('Gateway returned 401 mid-request; retrying once with a new token.');
        this.auth.invalidate(accessToken);
        await this.streamOnce(session, body, progress, token, /* allowRetry */ false, oneMContext);
        return;
      }
      // translateError replaces the gateway's own wording with advice, so the
      // original is logged first — otherwise the output channel has nothing to
      // diagnose a rejected request from.
      log.warn(`Gateway request for ${String(body.model)} failed: ${describe(error)}`);
      throw translateError(error);
    } finally {
      subscription.dispose();
    }
  }

  private createClient(workspaceOrigin: string, accessToken: string): Anthropic {
    return createGatewayClient(workspaceOrigin, accessToken);
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    // The gateway does not expose /v1/messages/count_tokens, so this is a local
    // estimate: ~4 characters per token, which is the usual English ratio. It is
    // only used for VS Code's own budgeting, never for billing.
    const content = typeof text === 'string' ? text : plainTextOf(text);
    return Math.ceil(content.length / 4);
  }
}

type CacheableBlock = Extract<
  ContentBlockParam,
  { type: 'text' | 'image' | 'tool_use' | 'tool_result' }
>;

function isCacheable(block: ContentBlockParam): block is CacheableBlock {
  return (
    block.type === 'text' ||
    block.type === 'image' ||
    block.type === 'tool_use' ||
    block.type === 'tool_result'
  );
}

/**
 * Marks the end of the tool list and of the conversation as cache breakpoints.
 * The tools-and-earlier-turns prefix is then reused by the next turn, which
 * extends the same prefix.
 */
export function applyCacheBreakpoints(body: Anthropic.MessageStreamParams): void {
  const lastTool = body.tools?.[body.tools.length - 1];
  if (lastTool && 'input_schema' in lastTool) {
    lastTool.cache_control = { type: 'ephemeral' };
  }

  const lastMessage = body.messages[body.messages.length - 1];
  if (lastMessage && Array.isArray(lastMessage.content)) {
    const lastBlock = lastMessage.content[lastMessage.content.length - 1];
    if (lastBlock && isCacheable(lastBlock)) {
      lastBlock.cache_control = { type: 'ephemeral' };
    }
  }
}

function clampMaxTokens(requested: unknown, maxOutputTokens: number): number {
  const value = typeof requested === 'number' && Number.isInteger(requested) && requested > 0
    ? requested
    : maxOutputTokens;
  return Math.min(value, maxOutputTokens);
}

function toolParams(
  options: vscode.ProvideLanguageModelChatResponseOptions,
): Partial<Pick<Anthropic.MessageStreamParams, 'tools' | 'tool_choice'>> {
  if (!options.tools?.length) {
    return {};
  }
  const tools: Tool[] = options.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: (tool.inputSchema as Tool['input_schema'] | undefined) ?? {
      type: 'object',
      properties: {},
    },
  }));
  const toolChoice: ToolChoice =
    options.toolMode === vscode.LanguageModelChatToolMode.Required
      ? { type: 'any' }
      : { type: 'auto' };
  return { tools, tool_choice: toolChoice };
}

/**
 * Converts VS Code's flat message list into Anthropic messages.
 *
 * VS Code models only User and Assistant roles, with no separate system role, so
 * every part stays in the turn history and `system` is left unset. Lifting the
 * first user message into `system` would misattribute a genuine user turn
 * whenever the caller did not start with harness instructions.
 */
export function toAnthropicMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): { messages: MessageParam[] } {
  const converted: MessageParam[] = [];
  for (const message of messages) {
    const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
    const content = toContentBlocks(message.content);
    if (content.length === 0) {
      continue;
    }
    converted.push({ role, content });
  }

  // Anthropic requires the first message to be from the user.
  while (converted.length > 0 && converted[0]!.role === 'assistant') {
    converted.shift();
  }

  return { messages: converted };
}

function toContentBlocks(parts: ReadonlyArray<unknown>): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  for (const part of parts) {
    if (part instanceof vscode.LanguageModelTextPart) {
      if (part.value) {
        blocks.push({ type: 'text', text: part.value });
      }
      continue;
    }
    if (part instanceof vscode.LanguageModelToolCallPart) {
      blocks.push({
        type: 'tool_use',
        id: part.callId,
        name: part.name,
        input: part.input ?? {},
      });
      continue;
    }
    if (part instanceof vscode.LanguageModelToolResultPart) {
      blocks.push({
        type: 'tool_result',
        tool_use_id: part.callId,
        content: toToolResultContent(part.content),
      });
      continue;
    }
    if (part instanceof vscode.LanguageModelDataPart) {
      const block = toDataBlock(part);
      if (block) {
        blocks.push(block);
      }
      continue;
    }
    // Unknown part kinds (e.g. prompt-tsx internals) are skipped rather than
    // guessed at: sending a malformed block fails the whole request.
    log.debug('Skipping an unrecognised message part.');
  }
  return blocks;
}

function toToolResultContent(
  parts: ReadonlyArray<unknown>,
): Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string } }> {
  const blocks: ReturnType<typeof toToolResultContent> = [];
  for (const part of parts) {
    if (part instanceof vscode.LanguageModelTextPart) {
      blocks.push({ type: 'text', text: part.value });
      continue;
    }
    if (part instanceof vscode.LanguageModelDataPart) {
      const block = toDataBlock(part);
      if (block?.type === 'image') {
        blocks.push(block);
      } else if (block?.type === 'text') {
        blocks.push(block);
      }
      continue;
    }
    if (part !== undefined && part !== null) {
      blocks.push({ type: 'text', text: safeStringify(part) });
    }
  }
  // A tool_result with no content is rejected by the API.
  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: '(no output)' });
  }
  return blocks;
}

const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function toDataBlock(
  part: vscode.LanguageModelDataPart,
):
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string };
    }
  | undefined {
  const mime = part.mimeType.toLowerCase();
  if (SUPPORTED_IMAGE_TYPES.has(mime)) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mime as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
        data: Buffer.from(part.data).toString('base64'),
      },
    };
  }
  if (mime.startsWith('text/') || mime === 'application/json') {
    return { type: 'text', text: Buffer.from(part.data).toString('utf8') };
  }
  log.debug(`Skipping an attachment of unsupported type ${part.mimeType}.`);
  return undefined;
}

/**
 * Turns the Anthropic SSE event stream into VS Code response parts.
 *
 * Text is forwarded delta by delta so it renders as it arrives. A tool call
 * cannot be: VS Code needs the complete input object, which only exists once the
 * block's `input_json_delta` fragments have all arrived. So tool inputs are
 * buffered per content-block index and emitted at `content_block_stop`, which
 * keeps tool calls in the same position they held in the model's output.
 */
class StreamRelay {
  private readonly pendingTools = new Map<number, { id: string; name: string; json: string }>();
  private usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  private sawUsage = false;

  constructor(private readonly progress: vscode.Progress<vscode.LanguageModelResponsePart>) {}

  logUsage(model: string): void {
    if (!this.sawUsage) {
      log.debug(`Gateway reported no usage for ${model}.`);
      return;
    }
    const { input, cacheRead, cacheWrite, output } = this.usage;
    log.info(
      `Usage for ${model}: input=${input} cache_read=${cacheRead} cache_write=${cacheWrite} output=${output}.`,
    );
  }

  handle(event: MessageStreamEvent): void {
    switch (event.type) {
      case 'message_start': {
        const usage = event.message.usage;
        log.debug(`message_start usage: ${JSON.stringify(usage)}`);
        this.sawUsage = true;
        this.usage.input = usage.input_tokens ?? 0;
        this.usage.cacheRead = usage.cache_read_input_tokens ?? 0;
        this.usage.cacheWrite = usage.cache_creation_input_tokens ?? 0;
        this.usage.output = usage.output_tokens ?? 0;
        return;
      }

      case 'message_delta': {
        // Fields here are cumulative; some gateways only fill them in at the end.
        const usage = event.usage;
        log.debug(`message_delta usage: ${JSON.stringify(usage)}`);
        this.sawUsage = true;
        this.usage.output = usage.output_tokens ?? this.usage.output;
        this.usage.input = usage.input_tokens ?? this.usage.input;
        // A delta that restates a cache count as 0 must not erase the value from message_start.
        this.usage.cacheRead = Math.max(this.usage.cacheRead, usage.cache_read_input_tokens ?? 0);
        this.usage.cacheWrite = Math.max(this.usage.cacheWrite, usage.cache_creation_input_tokens ?? 0);
        return;
      }

      case 'content_block_start':
        if (event.content_block.type === 'tool_use') {
          this.pendingTools.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            json: '',
          });
        }
        return;

      case 'content_block_delta':
        if (event.delta.type === 'text_delta') {
          if (event.delta.text) {
            this.progress.report(new vscode.LanguageModelTextPart(event.delta.text));
          }
          return;
        }
        if (event.delta.type === 'input_json_delta') {
          const pending = this.pendingTools.get(event.index);
          if (pending) {
            pending.json += event.delta.partial_json;
          }
          return;
        }
        // thinking_delta is not forwarded: VS Code has no part type for reasoning.
        return;

      case 'content_block_stop':
        this.emitTool(event.index);
        return;

      default:
        return;
    }
  }

  /** Flushes any block the stream ended without closing (cancellation, truncation). */
  finish(): void {
    for (const index of [...this.pendingTools.keys()]) {
      this.emitTool(index);
    }
  }

  private emitTool(index: number): void {
    const pending = this.pendingTools.get(index);
    if (!pending) {
      return;
    }
    this.pendingTools.delete(index);

    // An empty fragment list means a no-argument tool, which is a valid `{}` call.
    const raw = pending.json.trim() || '{}';
    let input: object;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new SyntaxError('tool input was not a JSON object');
      }
      input = parsed;
    } catch (error) {
      // Truncated or malformed input must not be passed off as a real call:
      // VS Code would run the tool with silently wrong arguments.
      log.warn(
        `Dropping tool call ${pending.name}: the gateway returned unusable input (${describe(error)}).`,
      );
      this.progress.report(
        new vscode.LanguageModelTextPart(
          `\n[The model's call to ${pending.name} was incomplete and was not run.]\n`,
        ),
      );
      return;
    }

    this.progress.report(new vscode.LanguageModelToolCallPart(pending.id, pending.name, input));
  }
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof Anthropic.APIError && (error.status === 401 || error.status === 403);
}

/** Turns SDK errors into messages a user can act on. */
function translateError(error: unknown): Error {
  if (error instanceof NotSignedInError) {
    return new Error(
      'Your Databricks sign-in expired. Run "Databricks AI Gateway: Sign In" to sign in again.',
    );
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    if (status === 401 || status === 403) {
      return new Error(
        'The Databricks AI Gateway rejected the credential. Run "Databricks AI Gateway: Sign In" to sign in again.',
      );
    }
    if (status === 404) {
      return new Error(
        'The gateway does not recognise this model. Re-run "Databricks AI Gateway: Select Workspace" to refresh the model list.',
      );
    }
    if (status === 429) {
      return new Error('The Databricks AI Gateway is rate limiting this workspace. Try again shortly.');
    }
    return new Error(`The Databricks AI Gateway returned an error (HTTP ${status ?? 'unknown'}): ${error.message}`);
  }
  if (error instanceof Error) {
    return error;
  }
  return new Error(describe(error));
}

function familyOf(modelId: string): string {
  const match = /claude[-_.]?(opus|sonnet|haiku|fable)/i.exec(modelId);
  return match?.[1] ? `claude-${match[1].toLowerCase()}` : 'claude';
}

function plainTextOf(message: vscode.LanguageModelChatRequestMessage): string {
  const chunks: string[] = [];
  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      chunks.push(part.value);
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      chunks.push(part.name, safeStringify(part.input));
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      chunks.push(
        ...part.content.map((entry) =>
          entry instanceof vscode.LanguageModelTextPart ? entry.value : safeStringify(entry),
        ),
      );
    }
  }
  return chunks.join('\n');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
