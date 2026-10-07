import { AuthManager, withFreshToken } from './auth';
import { anthropicBaseUrl, readConfig } from './config';
import { log } from './log';

export interface GatewayModel {
  id: string;
  displayName: string;
  /**
   * Only set on synthesized 1M-context entries. Base entries fall back to
   * the configured limits.
   */
  maxInputTokens?: number;
  maxOutputTokens?: number;
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

export const ONE_M_MAX_INPUT_TOKENS = 872_000;
export const ONE_M_MAX_OUTPUT_TOKENS = 128_000;

/** Suffix marking a local 1M entry; stripped before the id reaches the gateway. */
export const ONE_M_SUFFIX = '[1m]';

/** The gateway opens the 1M window on the base model id via this beta flag. */
export const ONE_M_BETA = 'context-1m-2025-08-07';

/**
 * Base model names the gateway serves with a 1M context window.
 *
 * `/v1/models` advertises only the base ids, so every client that offers the
 * wider window has to carry the list itself.
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

/** Is this one of the locally synthesized 1M entries? */
export function isOneMVariant(id: string): boolean {
  return /\[1m\]$/i.test(id.trim());
}

/** The gateway id behind a local entry: the suffix is ours, not the gateway's. */
export function gatewayModelId(id: string): string {
  return id.trim().replace(/\[1m\]$/i, '');
}

/**
 * Adds a `<id>[1m]` companion for every model that accepts the wider window.
 *
 * The suffix is a local label only. The gateway serves the 1M window on the base
 * id behind the `context-1m-2025-08-07` beta flag, so the suffix is stripped and
 * the flag added when a request is sent; see {@link gatewayModelId}.
 *
 * Both entries are offered rather than one or the other because the wider window
 * is also the dearer one: which to spend is a per-request decision, not something
 * a global setting should decide.
 */
export function withOneMVariants(models: GatewayModel[]): GatewayModel[] {
  const expanded: GatewayModel[] = [];
  const seen = new Set(models.map((model) => model.id.toLowerCase()));
  for (const model of models) {
    // A gateway that starts reporting suffixed ids itself needs labelling, not doubling.
    const alreadyOneM = isOneMVariant(model.id);
    expanded.push(
      alreadyOneM
        ? {
            ...model,
            maxInputTokens: ONE_M_MAX_INPUT_TOKENS,
            maxOutputTokens: ONE_M_MAX_OUTPUT_TOKENS,
          }
        : model,
    );
    if (alreadyOneM || !supportsOneMContext(model.id)) {
      continue;
    }
    const id = `${model.id}${ONE_M_SUFFIX}`;
    if (seen.has(id.toLowerCase())) {
      continue;
    }
    seen.add(id.toLowerCase());
    expanded.push({
      id,
      displayName: `${model.displayName} (1M context)`,
      maxInputTokens: ONE_M_MAX_INPUT_TOKENS,
      maxOutputTokens: ONE_M_MAX_OUTPUT_TOKENS,
    });
  }
  return expanded;
}

/**
 * Lists the Claude models this workspace's gateway will actually serve.
 *
 * Only Anthropic Claude is approved on the gateway, so anything else the endpoint
 * reports is dropped rather than surfaced in the picker.
 * The endpoint reports `max_input_tokens`/`max_tokens` as 0, so context limits come
 * from settings instead — do not treat those fields as usable.
 *
 * The list is then widened with the `[1m]` entries, which the endpoint never
 * reports; see {@link withOneMVariants}.
 */
export async function discoverModels(
  auth: AuthManager,
  workspaceOrigin: string,
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

  let offered = readConfig().offerOneMContext ? withOneMVariants(models) : models;
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
