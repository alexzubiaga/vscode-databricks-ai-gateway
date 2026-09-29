import * as vscode from 'vscode';
import { GatewayModel } from './models';

/**
 * Everything the menu draws, captured when the menu opens.
 *
 * The snapshot is built from state the extension already holds — nothing here
 * costs a network round trip, so opening the menu never mints a token.
 */
export interface StatusSnapshot {
  signedIn: boolean;
  /** Display name of the signed-in account, when one has been observed. */
  accountLabel?: string;
  workspaceName?: string;
  workspaceOrigin?: string;
  /** Undefined until the workspace has been resolved and models discovered. */
  models?: GatewayModel[];
  claudeSettingsPath: string;
  claudeCodeConfigured: boolean;
  tokenServiceEndpoint?: string;
}

export type StatusMenuAction =
  | { kind: 'signIn' }
  | { kind: 'signOut' }
  | { kind: 'selectWorkspace' }
  | { kind: 'discoverModels' }
  | { kind: 'configureClaudeCode' }
  | { kind: 'openClaudeSettings' }
  | { kind: 'copyModelId'; modelId: string }
  | { kind: 'showLog' };

export interface StatusMenuItem extends vscode.QuickPickItem {
  /** Absent on separators and on purely informational rows. */
  action?: StatusMenuAction;
}

/**
 * Builds the status-and-actions quick pick.
 *
 * Every row that reads like an affordance carries an action, so there are no dead
 * entries: the "not signed in" row signs in, the workspace row switches workspace,
 * and a model row copies its id.
 */
export function buildStatusMenu(snapshot: StatusSnapshot): StatusMenuItem[] {
  const items: StatusMenuItem[] = [];
  const separator = (label: string) =>
    items.push({ label, kind: vscode.QuickPickItemKind.Separator });

  separator('Status');
  if (snapshot.signedIn) {
    items.push({
      label: '$(pass-filled) Signed in',
      description: snapshot.accountLabel ?? 'Databricks account',
    });
  } else {
    items.push({
      label: '$(circle-slash) Not signed in',
      description: 'Sign in to expose the approved Claude models',
      action: { kind: 'signIn' },
    });
  }

  items.push(
    snapshot.workspaceName
      ? {
          label: `$(server-environment) ${snapshot.workspaceName}`,
          description: snapshot.workspaceOrigin,
          detail: 'Switch workspace',
          action: { kind: 'selectWorkspace' },
        }
      : {
          label: '$(server-environment) No workspace selected',
          detail: 'Select a workspace',
          action: { kind: 'selectWorkspace' },
        },
  );

  // Configured means the settings file exists, so opening it is safe; otherwise
  // the row is the shortcut to writing it.
  items.push(
    snapshot.claudeCodeConfigured
      ? {
          label: '$(terminal) Claude Code: configured',
          description: snapshot.claudeSettingsPath,
          detail: 'Open the Claude settings file',
          action: { kind: 'openClaudeSettings' },
        }
      : {
          label: '$(terminal) Claude Code: not configured',
          detail: 'Point Claude Code at the gateway',
          action: { kind: 'configureClaudeCode' },
        },
  );

  if (snapshot.signedIn) {
    items.push({
      label: '$(radio-tower) Token service',
      description: snapshot.tokenServiceEndpoint ?? 'not running',
    });
  }

  if (snapshot.signedIn) {
    const models = snapshot.models ?? [];
    if (models.length > 0) {
      // The copy hint lives on the separator rather than on each row: a `detail`
      // per model would double the height of the list for no extra information.
      separator(`Models (${models.length}) · pick one to copy its id`);
      for (const model of models) {
        items.push({
          label: `$(sparkle) ${model.displayName}`,
          description: model.id,
          action: { kind: 'copyModelId', modelId: model.id },
        });
      }
    } else {
      separator('Models');
      items.push(
        snapshot.workspaceOrigin
          ? {
              label: '$(sync) Discover models',
              detail: 'Ask the gateway which Claude models this workspace serves',
              action: { kind: 'discoverModels' },
            }
          : {
              label: '$(server-environment) Select a workspace to list models',
              action: { kind: 'selectWorkspace' },
            },
      );
    }
  }

  separator('Actions');
  if (snapshot.signedIn) {
    if ((snapshot.models ?? []).length > 0) {
      items.push({ label: '$(sync) Refresh models', action: { kind: 'discoverModels' } });
    }
    items.push({
      label: '$(tools) Configure Claude Code',
      action: { kind: 'configureClaudeCode' },
    });
    items.push({ label: '$(sign-out) Sign out', action: { kind: 'signOut' } });
  } else {
    items.push({ label: '$(sign-in) Sign in', action: { kind: 'signIn' } });
  }
  items.push({ label: '$(output) Show log', action: { kind: 'showLog' } });

  return items;
}

/** One-line summary for the quick pick's prompt. */
export function describeSnapshot(snapshot: StatusSnapshot): string {
  if (!snapshot.signedIn) {
    return 'Not signed in';
  }
  const models = snapshot.models;
  if (!models) {
    return snapshot.workspaceName
      ? `${snapshot.workspaceName} — models not discovered yet`
      : 'Signed in — no workspace selected';
  }
  return `${snapshot.workspaceName} — ${models.length} Claude model(s)`;
}
