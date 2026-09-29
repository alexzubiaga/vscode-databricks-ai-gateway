import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function initLog(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel('Databricks AI Gateway', { log: true });
  return channel;
}

/**
 * Never pass tokens, authorization codes or PKCE verifiers to these. The log is
 * user-visible and frequently pasted into support threads.
 */
export const log = {
  info: (message: string, ...args: unknown[]) => initLog().info(message, ...args),
  warn: (message: string, ...args: unknown[]) => initLog().warn(message, ...args),
  error: (message: string, ...args: unknown[]) => initLog().error(message, ...args),
  debug: (message: string, ...args: unknown[]) => initLog().debug(message, ...args),
  show: () => initLog().show(true),
};
