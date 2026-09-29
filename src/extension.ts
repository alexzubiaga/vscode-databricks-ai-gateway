import * as vscode from 'vscode';
import { AuthManager, NotSignedInError, gatewayConfigOrThrow } from './auth';
import { GatewayAuthenticationProvider } from './authProvider';
import { ClaudeCodeConfigurator, claudeSettingsPath } from './claudeCode';
import { ConfigurationError, VENDOR_ID, readConfig, requireWorkspaceOrigin } from './config';
import { OneMProbeCache, discoverModels } from './models';
import { describe } from './oauth';
import { GatewayChatProvider, SessionState } from './provider';
import {
  StatusMenuAction,
  StatusSnapshot,
  buildStatusMenu,
  describeSnapshot,
} from './statusMenu';
import { TokenService } from './tokenService';
import { Workspace, chooseWorkspace } from './workspaces';
import { initLog, log } from './log';

const WORKSPACE_STATE_KEY = 'databricksAigw.workspace';
const CLAUDE_CODE_STATE_KEY = 'databricksAigw.claudeCodeConfigured';
/**
 * `{ [workspaceOrigin]: { [suffixedModelId]: served } }` — see {@link OneMProbeCache}.
 *
 * Versioned: the first build to probe did so with a hand-rolled request that
 * could 404 on its own account, and cached the result. Those verdicts are wrong
 * and would keep working models out of the picker, so the new key starts empty
 * rather than inheriting them.
 */
const ONE_M_STATE_KEY = 'databricksAigw.oneMSupport.v2';
const STALE_ONE_M_STATE_KEYS = ['databricksAigw.oneMSupport'];

type OneMSupportState = Record<string, Record<string, boolean>>;

interface StoredWorkspace {
  name: string;
  origin: string;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(initLog());
  log.info('Databricks AI Gateway extension activating.');

  const auth = new AuthManager(context.secrets);
  context.subscriptions.push(auth);

  /**
   * Remembers which `[1m]` ids each workspace answered to.
   *
   * Entitlements are a property of the workspace, not of the window, so the
   * verdicts outlive both — otherwise every startup would re-spend a probe per
   * candidate model.
   */
  for (const stale of STALE_ONE_M_STATE_KEYS) {
    if (context.globalState.get(stale) !== undefined) {
      log.info(`Discarding 1M-context probe verdicts cached under ${stale}.`);
      void context.globalState.update(stale, undefined);
    }
  }

  const oneMCache: OneMProbeCache = {
    get: (workspaceOrigin) => context.globalState.get<OneMSupportState>(ONE_M_STATE_KEY)?.[workspaceOrigin],
    set: async (workspaceOrigin, verdicts) => {
      const all = { ...(context.globalState.get<OneMSupportState>(ONE_M_STATE_KEY) ?? {}) };
      all[workspaceOrigin] = verdicts;
      await context.globalState.update(ONE_M_STATE_KEY, all);
    },
  };

  const tokenService = new TokenService(auth);
  context.subscriptions.push({ dispose: () => tokenService.dispose() });

  const claudeCode = new ClaudeCodeConfigurator(context, tokenService);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'databricksAigw.showStatus';
  context.subscriptions.push(status);

  let session: SessionState | undefined;
  /** Deduplicates the concurrent silent resolves VS Code issues on startup. */
  let resolving: Promise<SessionState | undefined> | undefined;

  const updateStatus = () => {
    if (session) {
      status.text = `$(databricks-aigw-cat) ${session.models.length} Claude model(s)`;
      status.tooltip =
        `Databricks AI Gateway: ${session.workspaceName}\n${session.workspaceOrigin}\n` +
        'Click for status and actions.';
      status.backgroundColor = undefined;
    } else {
      status.text = '$(databricks-aigw-cat) Databricks AI Gateway: sign in';
      status.tooltip =
        'Sign in to expose the approved Claude models to VS Code chat.\nClick for status and actions.';
    }
    status.show();
  };

  /**
   * Resolves the workspace + model list.
   *
   * `silent` distinguishes VS Code probing for models in the background (never
   * show a browser or a picker) from a user-driven command (prompting is fine).
   * `revalidate` re-takes the 1M-context probes instead of trusting the cached
   * verdicts, for when the user has explicitly asked to re-read the gateway.
   */
  const resolveSession = async (
    silent: boolean,
    revalidate = false,
  ): Promise<SessionState | undefined> => {
    if (session) {
      return session;
    }
    if (resolving) {
      return await resolving;
    }
    const attempt = (async () => {
      try {
        const config = gatewayConfigOrThrow();
        if (!(await auth.hasStoredCredential())) {
          if (silent) {
            return undefined;
          }
          await signIn();
          return session;
        }

        const stored = context.globalState.get<StoredWorkspace>(WORKSPACE_STATE_KEY);
        let workspace: Workspace | undefined;
        if (stored?.origin) {
          try {
            workspace = { name: stored.name, origin: requireWorkspaceOrigin(stored.origin) };
          } catch (error) {
            log.warn(`Discarding a stored workspace that is no longer valid: ${describe(error)}`);
          }
        }
        if (!workspace) {
          if (silent) {
            return undefined;
          }
          workspace = await chooseWorkspace(auth, config, { forcePrompt: false });
          if (!workspace) {
            return undefined;
          }
          await context.globalState.update(WORKSPACE_STATE_KEY, {
            name: workspace.name,
            origin: workspace.origin,
          } satisfies StoredWorkspace);
        }

        const models = await discoverModels(auth, workspace.origin, {
          cache: oneMCache,
          revalidateOneM: revalidate,
        });
        session = {
          workspaceOrigin: workspace.origin,
          workspaceName: workspace.name,
          models,
        };
        updateStatus();
        return session;
      } catch (error) {
        if (error instanceof NotSignedInError && silent) {
          return undefined;
        }
        throw error;
      }
    })();

    // Assign before attaching the reset, and reset only from a later microtask.
    // Clearing inside the async body would run before this assignment and leave a
    // settled promise cached here for the rest of the session.
    resolving = attempt;
    void attempt
      .catch(() => undefined)
      .finally(() => {
        if (resolving === attempt) {
          resolving = undefined;
        }
      });
    return await attempt;
  };

  const provider = new GatewayChatProvider(
    auth,
    () => session,
    (silent) => resolveSession(silent),
  );
  context.subscriptions.push(provider);
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, provider));

  /**
   * Re-points the Claude Code helper at this session's token service.
   *
   * The service picks a fresh port and a fresh shared secret on every activation,
   * so a helper script written by an earlier session would authenticate against a
   * port that no longer exists. Without this, Claude Code breaks after each
   * VS Code restart until the user re-ran the configure command.
   */
  const rewriteClaudeCodeHelper = async (): Promise<void> => {
    if (!context.globalState.get<boolean>(CLAUDE_CODE_STATE_KEY)) {
      return;
    }
    const stored = context.globalState.get<StoredWorkspace>(WORKSPACE_STATE_KEY);
    if (!stored?.origin) {
      return;
    }
    try {
      const origin = requireWorkspaceOrigin(stored.origin);
      await claudeCode.apply(origin);
      log.info('Refreshed the Claude Code helper for this session.');
    } catch (error) {
      log.warn(`Could not refresh the Claude Code helper: ${describe(error)}`);
    }
  };

  const signIn = async (): Promise<void> => {
    const config = gatewayConfigOrThrow();
    await tokenService.start(config.tokenServicePort);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Databricks AI Gateway',
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ message: 'Waiting for browser sign-in…' });
        await auth.signIn(token);

        progress.report({ message: 'Finding your workspaces…' });
        const workspace = await chooseWorkspace(auth, config, { forcePrompt: false });
        if (!workspace) {
          throw new vscode.CancellationError();
        }
        await context.globalState.update(WORKSPACE_STATE_KEY, {
          name: workspace.name,
          origin: workspace.origin,
        } satisfies StoredWorkspace);

        progress.report({ message: `Discovering models on ${workspace.name}…` });
        const models = await discoverModels(auth, workspace.origin, { cache: oneMCache });
        session = { workspaceOrigin: workspace.origin, workspaceName: workspace.name, models };
        updateStatus();
        provider.refresh();

        if (readConfig().configureClaudeCodeOnSignIn) {
          progress.report({ message: 'Configuring Claude Code…' });
          await configureClaudeCode(workspace.origin, { quiet: true });
        }
      },
    );

    void vscode.window.showInformationMessage(
      `Databricks AI Gateway ready: ${session?.models.length ?? 0} Claude model(s) from ${session?.workspaceName}.`,
      'Show status',
    ).then((choice) => {
      if (choice === 'Show status') {
        void vscode.commands.executeCommand('databricksAigw.showStatus');
      }
    });
  };

  const configureClaudeCode = async (
    workspaceOrigin: string,
    options: { quiet: boolean },
  ): Promise<void> => {
    const wiring = await claudeCode.apply(workspaceOrigin);
    await context.globalState.update(CLAUDE_CODE_STATE_KEY, true);
    log.info(`Claude Code settings written to ${wiring.settingsPath}.`);
    if (options.quiet) {
      return;
    }
    const backupNote = wiring.backupPath ? ` A backup was saved next to it.` : '';
    void vscode.window.showInformationMessage(
      `Claude Code now uses ${wiring.baseUrl}. Updated ${wiring.settingsPath}.${backupNote} ` +
        'Restart any running claude session to pick it up.',
    );
  };

  const signOut = async (): Promise<void> => {
    await auth.signOut();
    await context.globalState.update(WORKSPACE_STATE_KEY, undefined);
    await context.globalState.update(ONE_M_STATE_KEY, undefined);
    session = undefined;
    tokenService.dispose();
    await claudeCode.revert();
    await context.globalState.update(CLAUDE_CODE_STATE_KEY, undefined);
    updateStatus();
    provider.reset();
    void vscode.window.showInformationMessage(
      'Signed out of Databricks AI Gateway. The Claude Code settings keys were removed.',
    );
  };

  const selectWorkspace = async (): Promise<void> => {
    const config = gatewayConfigOrThrow();
    if (!(await auth.hasStoredCredential())) {
      await signIn();
      return;
    }
    const workspace = await chooseWorkspace(auth, config, { forcePrompt: true });
    if (!workspace) {
      return;
    }
    await context.globalState.update(WORKSPACE_STATE_KEY, {
      name: workspace.name,
      origin: workspace.origin,
    } satisfies StoredWorkspace);

    await tokenService.start(config.tokenServicePort);
    const models = await discoverModels(auth, workspace.origin, {
      cache: oneMCache,
      revalidateOneM: true,
    });
    session = { workspaceOrigin: workspace.origin, workspaceName: workspace.name, models };
    updateStatus();
    provider.refresh();

    if (readConfig().configureClaudeCodeOnSignIn) {
      await configureClaudeCode(workspace.origin, { quiet: true });
    }
    void vscode.window.showInformationMessage(
      `Using ${workspace.name}: ${models.length} Claude model(s).`,
    );
  };

  const configureClaudeCodeInteractive = async (): Promise<void> => {
    const config = gatewayConfigOrThrow();
    const active = session ?? (await resolveSession(false));
    if (!active) {
      throw new Error('Sign in and select a workspace first.');
    }
    await tokenService.start(config.tokenServicePort);
    await configureClaudeCode(active.workspaceOrigin, { quiet: false });
  };

  const authProvider = new GatewayAuthenticationProvider(
    auth,
    async () => {
      // A fresh sign-in must not keep a stale workspace/model list.
      session = undefined;
      await signIn();
    },
    () => signOut(),
  );

  /**
   * Presents the extension's whole surface — sign-in state, workspace, the model
   * list and every action — as one quick pick, reachable from the status bar.
   */
  const showMenu = async (): Promise<void> => {
    const stored = context.globalState.get<StoredWorkspace>(WORKSPACE_STATE_KEY);
    const snapshot: StatusSnapshot = {
      signedIn: await auth.hasStoredCredential(),
      accountLabel: authProvider.accountLabel,
      workspaceName: session?.workspaceName ?? stored?.name,
      workspaceOrigin: session?.workspaceOrigin ?? stored?.origin,
      models: session?.models,
      claudeSettingsPath: claudeSettingsPath(),
      claudeCodeConfigured: context.globalState.get<boolean>(CLAUDE_CODE_STATE_KEY) === true,
      tokenServiceEndpoint: tokenService.endpoint,
    };
    const picked = await vscode.window.showQuickPick(buildStatusMenu(snapshot), {
      title: 'Databricks AI Gateway',
      placeHolder: describeSnapshot(snapshot),
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (picked?.action) {
      await runMenuAction(picked.action);
    }
  };

  const runMenuAction = async (action: StatusMenuAction): Promise<void> => {
    switch (action.kind) {
      case 'signIn':
        session = undefined;
        await signIn();
        return;
      case 'signOut':
        await signOut();
        return;
      case 'selectWorkspace':
        await selectWorkspace();
        return;
      case 'discoverModels': {
        // Drop the cached list so the gateway is asked again rather than replayed,
        // and re-take the 1M probes: this is the action for "the picker is wrong".
        session = undefined;
        const active = await resolveSession(false, /* revalidate */ true);
        updateStatus();
        provider.refresh();
        void vscode.window.showInformationMessage(
          active
            ? `${active.workspaceName}: ${active.models.length} Claude model(s).`
            : 'No models were discovered.',
        );
        return;
      }
      case 'configureClaudeCode':
        await configureClaudeCodeInteractive();
        return;
      case 'openClaudeSettings':
        await vscode.window.showTextDocument(vscode.Uri.file(claudeSettingsPath()));
        return;
      case 'copyModelId':
        await vscode.env.clipboard.writeText(action.modelId);
        void vscode.window.showInformationMessage(`Copied ${action.modelId} to the clipboard.`);
        return;
      case 'showLog':
        log.show();
        return;
    }
  };

  const run = (name: string, action: () => Promise<void>) =>
    vscode.commands.registerCommand(name, async () => {
      try {
        await action();
      } catch (error) {
        if (error instanceof vscode.CancellationError) {
          return;
        }
        const message = describe(error);
        log.error(`${name} failed: ${message}`);
        const choice = await vscode.window.showErrorMessage(
          `Databricks AI Gateway: ${message}`,
          'Show log',
        );
        if (choice === 'Show log') {
          log.show();
        }
      }
    });

  context.subscriptions.push(
    run('databricksAigw.signIn', async () => {
      // A fresh sign-in must not keep a stale workspace/model list.
      session = undefined;
      await signIn();
    }),

    run('databricksAigw.signOut', signOut),

    run('databricksAigw.selectWorkspace', selectWorkspace),

    run('databricksAigw.configureClaudeCode', configureClaudeCodeInteractive),

    run('databricksAigw.showLog', async () => log.show()),

    run('databricksAigw.showStatus', showMenu),
  );

  // The Accounts menu is where VS Code users expect to find who they are signed in
  // as and how to sign out, so the credential is published there as a real session.
  context.subscriptions.push(authProvider);
  context.subscriptions.push(
    vscode.authentication.registerAuthenticationProvider(
      VENDOR_ID,
      'Databricks AI Gateway',
      authProvider,
      { supportsMultipleAccounts: false },
    ),
  );

  context.subscriptions.push(
    auth.onDidChangeSignInState(() => {
      void (async () => {
        // AuthManager clears the stored credential itself when a refresh token is
        // rejected. Without dropping the session here, the picker would keep
        // advertising models that every request now fails on.
        if (!(await auth.hasStoredCredential())) {
          session = undefined;
          updateStatus();
          provider.reset();
          return;
        }
        updateStatus();
        provider.refresh();
      })();
    }),
  );

  // Changing the account or filter invalidates the resolved workspace/models.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('databricksAigw')) {
        return;
      }
      // The 1M variants are synthesized during discovery and cached in the session,
      // so the toggle only takes effect if the list is discovered again.
      if (
        event.affectsConfiguration('databricksAigw.accountId') ||
        event.affectsConfiguration('databricksAigw.accountHost') ||
        event.affectsConfiguration('databricksAigw.workspaceFilter') ||
        event.affectsConfiguration('databricksAigw.offerOneMContext')
      ) {
        session = undefined;
        updateStatus();
        provider.reset();
        return;
      }
      updateStatus();
      provider.refresh();
    }),
  );

  updateStatus();

  // Bring the session up in the background so models are present in the picker
  // without the user running a command, but never prompt from activation.
  if (await auth.hasStoredCredential()) {
    // Publishes the account to the Accounts menu and caches its label for the
    // status menu, so neither has to mint a token of its own later.
    void authProvider
      .getSessions()
      .catch((error: unknown) => log.warn(`Could not publish the account: ${describe(error)}`));
    try {
      await tokenService.start(readConfig().tokenServicePort);
      await rewriteClaudeCodeHelper();
    } catch (error) {
      log.warn(`Token service did not start: ${describe(error)}`);
    }
    void resolveSession(true)
      .then(() => provider.refresh())
      .catch((error: unknown) => log.warn(`Background session resolve failed: ${describe(error)}`));
  }
}

export function deactivate(): void {
  log.info('Databricks AI Gateway extension deactivated.');
}

export { ConfigurationError };
