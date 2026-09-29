import * as vscode from 'vscode';

export interface GatewayConfig {
  accountHost: string;
  accountId: string;
  workspaceFilter: string;
  redirectPort: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  offerOneMContext: boolean;
  configureClaudeCodeOnSignIn: boolean;
  tokenServicePort: number;
}

export const VENDOR_ID = 'databricks-aigw';

/** The public OAuth client Databricks ships for user-to-machine desktop flows. */
export const OAUTH_CLIENT_ID = 'databricks-cli';

/** `offline_access` is what gets us a refresh token; without it every hour needs a browser. */
export const OAUTH_SCOPES = 'all-apis offline_access';

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function readConfig(): GatewayConfig {
  const section = vscode.workspace.getConfiguration('databricksAigw');
  return {
    accountHost: trimTrailingSlash(section.get<string>('accountHost') ?? ''),
    accountId: (section.get<string>('accountId') ?? '').trim(),
    workspaceFilter: (section.get<string>('workspaceFilter') ?? '').trim(),
    redirectPort: section.get<number>('redirectPort') ?? 8020,
    maxInputTokens: section.get<number>('maxInputTokens') ?? 200_000,
    maxOutputTokens: section.get<number>('maxOutputTokens') ?? 64_000,
    offerOneMContext: section.get<boolean>('offerOneMContext') ?? true,
    configureClaudeCodeOnSignIn: section.get<boolean>('configureClaudeCodeOnSignIn') ?? true,
    tokenServicePort: section.get<number>('tokenServicePort') ?? 0,
  };
}

export class ConfigurationError extends Error {}

export function validateConfig(config: GatewayConfig): void {
  const accountHost = safeUrl(config.accountHost);
  if (!accountHost || accountHost.protocol !== 'https:') {
    throw new ConfigurationError(
      `databricksAigw.accountHost must be an https URL, got ${config.accountHost || '(empty)'}.`,
    );
  }
  if (!/^[0-9a-f-]{36}$/i.test(config.accountId)) {
    throw new ConfigurationError('databricksAigw.accountId must be a Databricks account UUID.');
  }
  if (!Number.isInteger(config.redirectPort) || config.redirectPort < 1 || config.redirectPort > 65535) {
    throw new ConfigurationError('databricksAigw.redirectPort must be a port number between 1 and 65535.');
  }
  for (const [key, value] of [
    ['maxInputTokens', config.maxInputTokens],
    ['maxOutputTokens', config.maxOutputTokens],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new ConfigurationError(`databricksAigw.${key} must be a positive integer.`);
    }
  }
}

export function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * Rejects anything that is not a plain https origin. Workspace hosts end up in
 * request URLs and in the Claude settings file, so a value carrying a path,
 * query or credentials is refused rather than normalised away.
 */
export function requireWorkspaceOrigin(workspaceUrl: string): string {
  const parsed = safeUrl(workspaceUrl);
  if (!parsed || parsed.protocol !== 'https:' || !parsed.hostname) {
    throw new ConfigurationError(`Workspace URL is not an https URL: ${workspaceUrl}`);
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new ConfigurationError(`Workspace URL must not carry a query, fragment or credentials: ${workspaceUrl}`);
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new ConfigurationError(`Workspace URL must not carry a path: ${workspaceUrl}`);
  }
  return parsed.origin;
}

export function accountAuthorizeUrl(config: GatewayConfig): string {
  return `${config.accountHost}/oidc/accounts/${config.accountId}/v1/authorize`;
}

export function accountTokenUrl(config: GatewayConfig): string {
  return `${config.accountHost}/oidc/accounts/${config.accountId}/v1/token`;
}

export function accountWorkspacesUrl(config: GatewayConfig): string {
  return `${config.accountHost}/api/2.0/accounts/${config.accountId}/workspaces`;
}

/** Databricks routes coding-agent traffic differently when this is set. */
export const CODING_AGENT_HEADER = 'x-databricks-use-coding-agent-mode';

/** The Anthropic-shaped gateway surface. `/v1/messages` and `/v1/models` hang off this. */
export function anthropicBaseUrl(workspaceOrigin: string): string {
  return `${workspaceOrigin}/ai-gateway/anthropic`;
}
