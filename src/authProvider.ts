import * as vscode from 'vscode';
import { AuthManager, NotSignedInError } from './auth';
import { OAUTH_SCOPES, readConfig } from './config';
import { describe } from './oauth';
import { log } from './log';

/** There is only ever one account credential, so the session id is a constant. */
const SESSION_ID = 'databricks-aigw-account';

const GRANTED_SCOPES = OAUTH_SCOPES.split(' ').filter(Boolean);

/**
 * Surfaces the Databricks credential in VS Code's Accounts menu.
 *
 * This is presentation over the existing {@link AuthManager}: the provider owns no
 * credential of its own, it just tells VS Code whether one exists and routes the
 * menu's sign-in/sign-out entries back into the extension's own flows, so a
 * sign-out from the Accounts menu also reverts the Claude Code wiring.
 *
 * Registering the provider also lets other extensions request this credential via
 * `vscode.authentication.getSession('databricks-aigw', …)`. VS Code gates that
 * behind its own per-extension consent prompt.
 */
export class GatewayAuthenticationProvider
  implements vscode.AuthenticationProvider, vscode.Disposable
{
  private readonly changeEmitter =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();

  readonly onDidChangeSessions = this.changeEmitter.event;

  /** The session VS Code has been told about, so changes are diffed not replayed. */
  private announced: vscode.AuthenticationSession | undefined;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly auth: AuthManager,
    private readonly runSignIn: () => Promise<void>,
    private readonly runSignOut: () => Promise<void>,
  ) {
    this.subscription = auth.onDidChangeSignInState(() => void this.announce());
  }

  dispose(): void {
    this.subscription.dispose();
    this.changeEmitter.dispose();
  }

  /** The account label last observed, for the extension's own status menu. */
  get accountLabel(): string | undefined {
    return this.announced?.account.label;
  }

  /**
   * VS Code calls this to render the Accounts menu and whenever an extension asks
   * for the session, so it must stay cheap and must not prompt. `getAccessToken`
   * returns the cached token unless it is within the renewal window.
   */
  async getSessions(scopes?: readonly string[]): Promise<vscode.AuthenticationSession[]> {
    if (scopes?.some((scope) => !GRANTED_SCOPES.includes(scope))) {
      return [];
    }
    if (!(await this.auth.hasStoredCredential())) {
      this.announced = undefined;
      return [];
    }
    try {
      const session = this.toSession(await this.auth.getAccessToken());
      this.announced = session;
      return [session];
    } catch (error) {
      if (!(error instanceof NotSignedInError)) {
        log.warn(`Could not produce an authentication session: ${describe(error)}`);
      }
      this.announced = undefined;
      return [];
    }
  }

  /** Reached from the Accounts menu or another extension's `createIfNone` request. */
  async createSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
    await this.runSignIn();
    const [session] = await this.getSessions(scopes);
    if (!session) {
      throw new Error('Sign-in finished without producing a Databricks credential.');
    }
    return session;
  }

  /**
   * Signs out through the extension's own flow rather than just dropping the token:
   * the Claude Code wiring and the stored workspace have to go with it.
   */
  async removeSession(sessionId: string): Promise<void> {
    if (sessionId !== SESSION_ID) {
      log.warn(`Ignoring a sign-out request for an unknown session ${sessionId}.`);
      return;
    }
    await this.runSignOut();
  }

  /** Diffs against what VS Code already knows and fires only real transitions. */
  private async announce(): Promise<void> {
    const previous = this.announced;
    const [current] = await this.getSessions();
    if (current && !previous) {
      this.changeEmitter.fire({ added: [current], removed: undefined, changed: undefined });
    } else if (!current && previous) {
      this.changeEmitter.fire({ added: undefined, removed: [previous], changed: undefined });
    } else if (current && previous && current.account.label !== previous.account.label) {
      this.changeEmitter.fire({ added: undefined, removed: undefined, changed: [current] });
    }
  }

  private toSession(accessToken: string): vscode.AuthenticationSession {
    const accountId = readConfig().accountId;
    return {
      id: SESSION_ID,
      accessToken,
      account: { id: accountId || SESSION_ID, label: accountLabel(accessToken) },
      scopes: GRANTED_SCOPES,
    };
  }
}

/**
 * Best-effort display name for the Accounts menu.
 *
 * The token is a JWT the account console just issued to us over TLS. The claim is
 * read for display only — never for an authorization decision — so the signature
 * is deliberately not verified, and anything unparseable falls back to a generic
 * label instead of failing the sign-in.
 */
export function accountLabel(accessToken: string): string {
  const claims = decodeJwtClaims(accessToken);
  for (const key of ['email', 'preferred_username', 'upn', 'sub']) {
    const value = claims?.[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return 'Databricks account';
}

function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const payload = token.split('.')[1];
  if (!payload) {
    return undefined;
  }
  try {
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
