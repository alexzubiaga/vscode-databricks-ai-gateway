import Anthropic from '@anthropic-ai/sdk';
import { AuthManager, withFreshToken } from './auth';
import { anthropicBaseUrl, readConfig } from './config';
import { createGatewayClient } from './gateway';
import { log } from './log';
import { describe } from './oauth';

export interface GatewayModel {
  id: string;
  displayName: string;
  /**
   * Only set on the synthesized 1M-context entries. Base entries leave it
   * undefined and fall back to the `maxInputTokens` setting.
   */
  contextWindow?: number;
}

class HttpStatusError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const isUnauthorized = (error: unknown) =>
  error instanceof HttpStatusError && (error.status === 401 || error.status === 403);

/** Ranks the families strongest first. */
const FAMILY_ORDER = ['opus', 'sonnet', 'haiku', 'fable'];

/** The window the `[1m]` suffix buys on the models that accept it. */
export const ONE_M_CONTEXT_WINDOW = 1_000_000;

/**
 * Base model names the gateway serves with a 1M context window.
 *
 * The suffix is a gateway convention rather than something `/v1/models` advertises,
 * so every client that offers the wider window has to carry the list itself.
 */
const ONE_M_MODELS = new Set([
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-fable-5-1',
]);

/** Strips the `system.ai.` prefix and any `[1m]` suffix, the way the scripts do. */
function baseName(id: string): string {
  const lower = id.trim().replace(/\[1m\]$/i, '').toLowerCase();
  return lower.startsWith('system.ai.') ? lower.slice('system.ai.'.length) : lower;
}

/** Exported for tests: does this model id accept the `[1m]` suffix? */
export function supportsOneMContext(id: string): boolean {
  return ONE_M_MODELS.has(baseName(id));
}

/** The `[1m]` ids {@link withOneMVariants} would synthesize for this base list. */
export function oneMCandidates(models: GatewayModel[]): string[] {
  return models
    .filter((model) => !/\[1m\]$/i.test(model.id) && supportsOneMContext(model.id))
    .map((model) => `${model.id}[1m]`);
}

/**
 * Adds a `<id>[1m]` companion for every model that accepts the wider window.
 *
 * The gateway routes the 1M window as a separate model id, not through a request
 * header, and `/v1/models` reports only the base ids — so the variants exist only
 * if a client synthesizes them. Both entries are offered rather than one or the
 * other because the wider window is also the dearer one: which to spend is a
 * per-request decision, not something a global setting should decide.
 *
 * The allowlist says which ids *may* carry the suffix; `accept` says which ones
 * this workspace's gateway actually answers to. See {@link probeOneMSupport}.
 */
export function withOneMVariants(
  models: GatewayModel[],
  accept: (candidateId: string) => boolean = () => true,
): GatewayModel[] {
  const expanded: GatewayModel[] = [];
  const seen = new Set(models.map((model) => model.id.toLowerCase()));
  for (const model of models) {
    // A gateway that starts reporting suffixed ids itself needs labelling, not doubling.
    const alreadyOneM = /\[1m\]$/i.test(model.id);
    expanded.push(alreadyOneM ? { ...model, contextWindow: ONE_M_CONTEXT_WINDOW } : model);
    if (alreadyOneM || !supportsOneMContext(model.id)) {
      continue;
    }
    const id = `${model.id}[1m]`;
    if (seen.has(id.toLowerCase()) || !accept(id)) {
      continue;
    }
    seen.add(id.toLowerCase());
    expanded.push({
      id,
      displayName: `${model.displayName} (1M context)`,
      contextWindow: ONE_M_CONTEXT_WINDOW,
    });
  }
  return expanded;
}

/**
 * Per-workspace record of which `[1m]` ids the gateway answered to.
 *
 * Probing costs a request per candidate, so the verdicts are remembered across
 * windows and only re-taken when the user explicitly re-resolves the workspace.
 */
export interface OneMProbeCache {
  get(workspaceOrigin: string): Readonly<Record<string, boolean>> | undefined;
  set(workspaceOrigin: string, verdicts: Record<string, boolean>): Promise<void>;
}

/** A probe is a one-token completion; it should answer or be abandoned quickly. */
const PROBE_TIMEOUT_MS = 20_000;

type ProbeVerdict = 'served' | 'missing' | 'unknown';

/**
 * Asks the gateway whether it serves one model id, by trying the smallest
 * completion there is (one output token).
 *
 * The request goes through {@link createGatewayClient}, the same client the chat
 * path uses. That matters more than it looks: a hand-rolled request can 404 for
 * reasons of its own — a missing `anthropic-version` header, say — and a probe
 * that fails differently from the real call is worse than no probe at all.
 *
 * - **404** — the gateway does not recognise the id.
 * - **Any other answer** — recognised well enough to be routed. A 400 in
 *   particular is a model rejecting a request, which it can only do if it exists.
 * - **No usable answer** (auth, rate limit, timeout, network) — `unknown`, so no
 *   caller hides a model on the strength of a verdict this never reached.
 */
async function probeModel(
  auth: AuthManager,
  workspaceOrigin: string,
  modelId: string,
): Promise<ProbeVerdict> {
  try {
    return await withFreshToken(
      auth,
      async (token) => {
        // maxRetries 0: a probe that cannot be answered first time is reported as
        // unknown, which is cheaper and more honest than retrying into a timeout.
        const client = createGatewayClient(workspaceOrigin, token, {
          timeoutMs: PROBE_TIMEOUT_MS,
          maxRetries: 0,
        });
        try {
          await client.messages.create({
            model: modelId,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }],
          });
          return 'served';
        } catch (error) {
          if (error instanceof Anthropic.APIError && error.status === 404) {
            log.debug(`The gateway answered 404 for ${modelId}: ${error.message}`);
            return 'missing';
          }
          // A 400 means the id routed somewhere; anything else is inconclusive
          // and is re-thrown so withFreshToken can re-auth and the catch below
          // can record "unknown".
          if (error instanceof Anthropic.APIError && error.status === 400) {
            return 'served';
          }
          throw error;
        }
      },
      isUnauthorized,
    );
  } catch (error) {
    log.debug(`Could not establish whether ${modelId} is served: ${describe(error)}`);
    return 'unknown';
  }
}

/**
 * Settles which `[1m]` variants this workspace serves, probing only the unknowns.
 *
 * A 404 is never taken at face value. Every candidate's base id came from
 * `/v1/models`, so the gateway certainly serves it — which makes it a control:
 * if the base id 404s too, the fault is in the probe, not in the variant, and
 * the verdict is downgraded to unknown. Without that check a probe broken in any
 * way at all reads as "this workspace serves no 1M models" and empties the
 * picker of models that work perfectly well.
 *
 * Unknown verdicts are neither returned nor cached: the next resolve asks again.
 */
async function resolveOneMSupport(
  auth: AuthManager,
  workspaceOrigin: string,
  candidates: string[],
  cache: OneMProbeCache | undefined,
  revalidate: boolean,
): Promise<Record<string, boolean>> {
  const known: Record<string, boolean> = revalidate ? {} : { ...(cache?.get(workspaceOrigin) ?? {}) };
  const unknown = candidates.filter((id) => typeof known[id] !== 'boolean');
  if (unknown.length === 0) {
    return known;
  }

  log.info(`Probing ${unknown.length} 1M-context variant(s) against the gateway.`);
  const verdicts = await Promise.all(
    unknown.map(async (id) => [id, await probeModel(auth, workspaceOrigin, id)] as const),
  );

  // One control per distinct base id, and only if something came back missing.
  const controls = new Map<string, Promise<ProbeVerdict>>();
  const control = (candidateId: string): Promise<ProbeVerdict> => {
    const base = candidateId.replace(/\[1m\]$/i, '');
    let pending = controls.get(base);
    if (!pending) {
      pending = probeModel(auth, workspaceOrigin, base);
      controls.set(base, pending);
    }
    return pending;
  };

  let settled = false;
  for (const [id, verdict] of verdicts) {
    if (verdict === 'unknown') {
      continue;
    }
    if (verdict === 'missing' && (await control(id)) !== 'served') {
      log.warn(
        `Not trusting the 404 for ${id}: its base model did not answer either, so the probe ` +
          'itself is failing. Offering the variant and re-probing next time.',
      );
      continue;
    }
    known[id] = verdict === 'served';
    settled = true;
  }
  if (settled && cache) {
    // Only ids the gateway actually answered about are persisted, so a cache
    // written during an outage cannot hide a variant for good.
    await cache.set(workspaceOrigin, known);
  }
  return known;
}

/**
 * Lists the Claude models this workspace's gateway will actually serve.
 *
 * Only Anthropic Claude is approved on the gateway, so anything else the endpoint
 * reports is dropped rather than surfaced in the picker.
 * The endpoint reports `max_input_tokens`/`max_tokens` as 0, so context limits come
 * from settings instead — do not treat those fields as usable.
 *
 * The list is then widened with the `[1m]` variants, which the endpoint never
 * reports and which are probed rather than assumed; see {@link withOneMVariants}
 * and {@link probeOneMSupport}.
 */
export async function discoverModels(
  auth: AuthManager,
  workspaceOrigin: string,
  options: { cache?: OneMProbeCache; revalidateOneM?: boolean } = {},
): Promise<GatewayModel[]> {
  const url = `${anthropicBaseUrl(workspaceOrigin)}/v1/models`;
  const payload = await withFreshToken(
    auth,
    async (token) => {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new HttpStatusError(
          response.status,
          `Model discovery returned HTTP ${response.status} from ${url}.`,
        );
      }
      return (await response.json()) as unknown;
    },
    isUnauthorized,
  );

  const entries =
    typeof payload === 'object' && payload !== null && Array.isArray((payload as { data?: unknown }).data)
      ? ((payload as { data: unknown[] }).data)
      : undefined;
  if (!entries) {
    throw new Error('The gateway model list did not contain a "data" array.');
  }

  const models: GatewayModel[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? record['id'].trim() : '';
    if (!id || !id.toLowerCase().includes('claude')) {
      continue;
    }
    const key = id.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const displayName =
      typeof record['display_name'] === 'string' && record['display_name'].trim()
        ? record['display_name'].trim()
        : prettifyId(id);
    models.push({ id, displayName });
  }

  if (models.length === 0) {
    throw new Error(
      'The gateway reported no Claude models for this workspace. Check whether AI Gateway is enabled on it.',
    );
  }

  let offered = models;
  if (readConfig().offerOneMContext) {
    const support = await resolveOneMSupport(
      auth,
      workspaceOrigin,
      oneMCandidates(models),
      options.cache,
      options.revalidateOneM === true,
    );
    // An id the gateway said nothing about is still offered: the allowlist is the
    // best guess available, and a request that fails says more than a model that
    // silently went missing from the picker.
    offered = withOneMVariants(models, (id) => support[id] !== false);
  }
  offered = [...offered].sort(compareModels);
  const oneM = offered.length - models.length;
  log.info(
    `Discovered ${models.length} Claude model(s) on the gateway` +
      (oneM > 0 ? `, plus ${oneM} 1M-context variant(s).` : '.'),
  );
  return offered;
}

/** Exported for tests: orders a model list the way the picker presents it. */
export function sortModels(models: GatewayModel[]): GatewayModel[] {
  return [...models].sort(compareModels);
}

/** Strongest family first, then newest version first within a family. */
function compareModels(left: GatewayModel, right: GatewayModel): number {
  const leftFamily = familyRank(left.id);
  const rightFamily = familyRank(right.id);
  if (leftFamily !== rightFamily) {
    return leftFamily - rightFamily;
  }
  const versionDelta = versionKey(right.id) - versionKey(left.id);
  if (versionDelta !== 0) {
    return versionDelta;
  }
  return left.id.localeCompare(right.id);
}

function familyRank(id: string): number {
  const lower = id.toLowerCase();
  const index = FAMILY_ORDER.findIndex((family) => lower.includes(family));
  return index === -1 ? FAMILY_ORDER.length : index;
}

/**
 * `claude-opus-4-5` -> 4.5, so 5 sorts above 4.8 above 4.5.
 *
 * The `[1m]` suffix is stripped first: it ends in a digit, and this reads the
 * *last* number in the id, so leaving it on would rank Opus 5[1m] as version 1.
 */
function versionKey(id: string): number {
  const match = /(\d+)(?:-(\d+))?(?!.*\d)/.exec(id.replace(/\[1m\]$/i, ''));
  if (!match?.[1]) {
    return 0;
  }
  const major = Number(match[1]);
  const minor = match[2] ? Number(match[2]) : 0;
  return major * 1000 + minor;
}

function prettifyId(id: string): string {
  const fromClaude = /claude.*/i.exec(id)?.[0] ?? id;
  return fromClaude
    .split(/[._:/-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
