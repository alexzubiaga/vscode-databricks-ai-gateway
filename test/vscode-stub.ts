// Minimal stand-in for the `vscode` module so the extension's pure logic can be
// unit tested outside an extension host. Only what the tested code touches.

export class LanguageModelTextPart {
  constructor(public value: string) {}
}

export class LanguageModelToolCallPart {
  constructor(public callId: string, public name: string, public input: object) {}
}

export class LanguageModelToolResultPart {
  constructor(public callId: string, public content: unknown[]) {}
}

export class LanguageModelDataPart {
  constructor(public data: Uint8Array, public mimeType: string) {}
}

export class LanguageModelPromptTsxPart {
  constructor(public value: unknown) {}
}

export enum LanguageModelChatMessageRole {
  User = 1,
  Assistant = 2,
}

export enum LanguageModelChatToolMode {
  Auto = 1,
  Required = 2,
}

export enum QuickPickItemKind {
  Separator = -1,
  Default = 0,
}

export class CancellationError extends Error {}

export class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];
  event = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => undefined };
  };
  fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
  dispose(): void {
    this.listeners = [];
  }
}

// Test-controlled settings backing `vscode.workspace.getConfiguration`.
export const __settings = new Map<string, unknown>();

// A real filesystem-backed `workspace.fs`, so the settings-merge code under test
// exercises its actual read/write/copy paths against a temp directory.
import * as nodeFs from 'node:fs/promises';
import * as nodePath from 'node:path';

export const workspace = {
  getConfiguration: (_section: string) => ({
    get: <T>(key: string): T | undefined => __settings.get(key) as T | undefined,
  }),
  fs: {
    readFile: async (uri: string): Promise<Uint8Array> => new Uint8Array(await nodeFs.readFile(uri)),
    writeFile: async (uri: string, content: Uint8Array): Promise<void> => {
      await nodeFs.mkdir(nodePath.dirname(uri), { recursive: true });
      await nodeFs.writeFile(uri, content);
    },
    createDirectory: async (uri: string): Promise<void> => {
      await nodeFs.mkdir(uri, { recursive: true });
    },
    copy: async (source: string, target: string, options?: { overwrite?: boolean }): Promise<void> => {
      await nodeFs.copyFile(source, target, options?.overwrite ? 0 : undefined);
    },
  },
};

export const window = {
  createOutputChannel: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    show: () => undefined,
    dispose: () => undefined,
  }),
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  showInformationMessage: async () => undefined,
  showErrorMessage: async () => undefined,
};

export const env = { openExternal: async () => true };
export const Uri = { parse: (value: string) => value, file: (value: string) => value };
export const lm = { registerLanguageModelChatProvider: () => ({ dispose: () => undefined }) };
export const ProgressLocation = { Notification: 15 };
export const StatusBarAlignment = { Right: 2 };
