import * as vscode from 'vscode';
import {
  GatewayConfig,
  OAUTH_CLIENT_ID,
  OAUTH_SCOPES,
  accountAuthorizeUrl,
  accountTokenUrl,
  readConfig,
  validateConfig,
} from './config';
import { OAuthError, TokenResponse, authorize, describe, refresh } from './oauth';
import { log } from './log';

const REFRESH_TOKEN_KEY = 'databricksAigw.refreshToken';
/** Renew this far before expiry so an in-flight request never carries a dead token. */
const EXPIRY_SKEW_MS = 120_000;

export class NotSignedInError extends Error {
  constructor() {
    super('Not signed in to Databricks AI Gateway.');
  }
}

/**
 * Owns the account-level OAuth credential.
 *
 * One account token is enough for everything this extension does: the same token
 * lists the account's workspaces and authenticates against each workspace's
 * AI Gateway, so sign-in is a single browser round trip.
 */
export class AuthManager {
  private accessToken: string | undefined;
  private expiresAt = 0;
  private inFlight: Promise<string> | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<void>();

  readonly onDidChangeSignInState = this.changeEmitter.event;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  dispose(): void {
    this.changeEmitter.dispose();
  }

  async hasStoredCredential(): Promise<boolean> {
    return (await this.secrets.get(REFRESH_TOKEN_KEY)) !== undefined;
  }

  /** Interactive sign-in. Replaces any stored credential. */
  async signIn(token: vscode.CancellationToken): Promise<void> {
    const config = readConfig();
    validateConfig(config);

    const result = await authorize(
      {
        authorizeUrl: accountAuthorizeUrl(config),
        tokenUrl: accountTokenUrl(config),
        clientId: OAUTH_CLIENT_ID,
        scopes: OAUTH_SCOPES,
        redirectPort: config.redirectPort,
      },
      token,
    );

    await this.store(result);
    log.info('Signed in to the Databricks account.');
    this.changeEmitter.fire();
  }

  async signOut(): Promise<void> {
    await this.secrets.delete(REFRESH_TOKEN_KEY);
    this.accessToken = undefined;
    this.expiresAt = 0;
    this.inFlight = undefined;
    log.info('Signed out; the stored refresh token was deleted.');
    this.changeEmitter.fire();
  }

  /**
   * Returns a valid access token, refreshing when needed.
   *
   * Concurrent callers share one refresh: VS Code chat can fan out several
   * requests at once and each would otherwise start its own token exchange.
   */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - EXPIRY_SKEW_MS) {
      return this.accessToken;
    }
    this.inFlight ??= this.renew().finally(() => {
      this.inFlight = undefined;
    });
    return await this.inFlight;
  }

  /** Drops the cached access token so the next call re-mints. Used after a 401. */
  invalidate(token: string): void {
    if (this.accessToken === token) {
      this.accessToken = undefined;
      this.expiresAt = 0;
    }
  }

  private async renew(): Promise<string> {
    const refreshToken = await this.secrets.get(REFRESH_TOKEN_KEY);
    if (!refreshToken) {
      throw new NotSignedInError();
    }
    const config = readConfig();
    validateConfig(config);

    let result: TokenResponse;
    try {
      result = await refresh(accountTokenUrl(config), OAUTH_CLIENT_ID, refreshToken, OAUTH_SCOPES);
    } catch (error) {
      // An expired or revoked refresh token is terminal: clear it so the UI can
      // ask for a fresh sign-in instead of retrying a grant that cannot succeed.
      if (error instanceof OAuthError) {
        log.warn(`Token refresh failed, clearing the stored credential: ${error.message}`);
        await this.secrets.delete(REFRESH_TOKEN_KEY);
        this.changeEmitter.fire();
        throw new NotSignedInError();
      }
      throw error;
    }

    await this.store(result);
    log.debug('Renewed the Databricks access token.');
    return result.accessToken;
  }

  private async store(result: TokenResponse): Promise<void> {
    this.accessToken = result.accessToken;
    this.expiresAt = result.expiresAt;
    if (result.refreshToken) {
      // Databricks rotates refresh tokens, so persist every issued one.
      await this.secrets.store(REFRESH_TOKEN_KEY, result.refreshToken);
    }
  }
}

/** Runs `request`, retrying once with a freshly minted token if the first call 401s. */
export async function withFreshToken<T>(
  auth: AuthManager,
  request: (token: string) => Promise<T>,
  isUnauthorized: (error: unknown) => boolean,
): Promise<T> {
  const token = await auth.getAccessToken();
  try {
    return await request(token);
  } catch (error) {
    if (!isUnauthorized(error)) {
      throw error;
    }
    log.debug(`Retrying once after an authorization failure: ${describe(error)}`);
    auth.invalidate(token);
    return await request(await auth.getAccessToken());
  }
}

export function gatewayConfigOrThrow(): GatewayConfig {
  const config = readConfig();
  validateConfig(config);
  return config;
}
