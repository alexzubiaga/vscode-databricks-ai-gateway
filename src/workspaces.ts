import * as vscode from 'vscode';
import { AuthManager, withFreshToken } from './auth';
import { GatewayConfig, accountWorkspacesUrl, requireWorkspaceOrigin } from './config';
import { log } from './log';
import { describe } from './oauth';

export interface Workspace {
  name: string;
  /** Bare https origin, e.g. `https://dbc-1234.cloud.databricks.com`. */
  origin: string;
  region?: string;
}

class HttpStatusError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const isUnauthorized = (error: unknown) =>
  error instanceof HttpStatusError && (error.status === 401 || error.status === 403);

export async function listWorkspaces(
  auth: AuthManager,
  config: GatewayConfig,
): Promise<Workspace[]> {
  const raw = await withFreshToken(
    auth,
    async (token) => {
      const response = await fetch(accountWorkspacesUrl(config), {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new HttpStatusError(
          response.status,
          `The Databricks account workspace list returned HTTP ${response.status}.`,
        );
      }
      return (await response.json()) as unknown;
    },
    isUnauthorized,
  );

  if (!Array.isArray(raw)) {
    throw new Error('The Databricks account workspace list was not a JSON array.');
  }

  const workspaces: Workspace[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record['workspace_name'] === 'string' ? record['workspace_name'].trim() : '';
    const host = resolveHost(record);
    if (!name || !host) {
      continue;
    }
    let origin: string;
    try {
      origin = requireWorkspaceOrigin(host);
    } catch (error) {
      log.warn(`Skipping workspace ${name}: ${describe(error)}`);
      continue;
    }
    workspaces.push({
      name,
      origin,
      region: typeof record['aws_region'] === 'string' ? record['aws_region'] : undefined,
    });
  }

  return workspaces.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * `workspace_fqdn` is the field the account API actually populates;
 * `deployment_name` is the documented fallback and needs the domain appended.
 */
function resolveHost(record: Record<string, unknown>): string | undefined {
  const fqdn = record['workspace_fqdn'];
  if (typeof fqdn === 'string' && fqdn.trim()) {
    return `https://${fqdn.trim()}`;
  }
  const explicit = record['workspace_url'];
  if (typeof explicit === 'string' && explicit.trim()) {
    return explicit.trim();
  }
  const deployment = record['deployment_name'];
  if (typeof deployment === 'string' && deployment.trim()) {
    const value = deployment.trim();
    return value.startsWith('https://') ? value : `https://${value}.cloud.databricks.com`;
  }
  return undefined;
}

export function filterWorkspaces(workspaces: Workspace[], filter: string): Workspace[] {
  if (!filter) {
    return workspaces;
  }
  const needle = filter.toLowerCase();
  return workspaces.filter((workspace) => workspace.name.toLowerCase().includes(needle));
}

/**
 * Picks the workspace to use. A single eligible workspace is selected without
 * prompting; several are offered in a quick pick — the first of many is never
 * taken silently, so the user sees what they are getting.
 */
export async function chooseWorkspace(
  auth: AuthManager,
  config: GatewayConfig,
  options: { forcePrompt: boolean },
): Promise<Workspace | undefined> {
  const all = await listWorkspaces(auth, config);
  if (all.length === 0) {
    throw new Error('This Databricks account reported no workspaces for your login.');
  }

  const eligible = filterWorkspaces(all, config.workspaceFilter);
  if (eligible.length === 0) {
    throw new Error(
      `No workspace name contains "${config.workspaceFilter}". ` +
        `Your login sees ${all.length} workspace(s). Adjust databricksAigw.workspaceFilter to widen the search.`,
    );
  }

  if (eligible.length === 1 && !options.forcePrompt) {
    return eligible[0];
  }

  const picked = await vscode.window.showQuickPick(
    eligible.map((workspace) => ({
      label: workspace.name,
      description: workspace.region,
      detail: workspace.origin,
      workspace,
    })),
    {
      title: 'Select a Databricks AI Gateway workspace',
      placeHolder: 'Claude models are discovered from the workspace you pick',
      ignoreFocusOut: true,
      matchOnDetail: true,
    },
  );
  return picked?.workspace;
}
