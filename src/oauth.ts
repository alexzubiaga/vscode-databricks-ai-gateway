import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as vscode from 'vscode';
import { log } from './log';

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. Derived from `expires_in`, or from the JWT when absent. */
  expiresAt: number;
}

export class OAuthError extends Error {}

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** Exported for tests. */
export function createPkce(): Pkce {
  // 32 random bytes -> 43 base64url chars, the RFC 7636 minimum verifier length.
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

const RESULT_PAGE = (heading: string, detail: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Databricks AI Gateway</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:8vh auto;max-width:34rem;padding:0 1.5rem;color:#1c1c1c}
h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#555;margin:0}</style></head>
<body><h1>${heading}</h1><p>${detail}</p></body></html>`;

/**
 * Serves the single OAuth redirect on the loopback interface and resolves with
 * the authorization code. The port is fixed because Databricks only allowlists
 * `http://localhost:<port>` redirects it knows about for the `databricks-cli`
 * public client — picking a free port instead would get the request rejected.
 */
async function listenForCode(
  port: number,
  expectedState: string,
  token: vscode.CancellationToken,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | undefined, code?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      server.close();
      subscription.dispose();
      if (error) {
        reject(error);
      } else {
        resolve(code!);
      }
    };

    const server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', `http://localhost:${port}`);
      if (requestUrl.pathname !== '/' && requestUrl.pathname !== '/callback') {
        response.writeHead(404).end();
        return;
      }

      const params = requestUrl.searchParams;
      const error = params.get('error');
      const code = params.get('code');
      const state = params.get('state');

      const sendPage = (status: number, heading: string, detail: string) => {
        const body = RESULT_PAGE(heading, detail);
        response.writeHead(status, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store',
        });
        response.end(body);
      };

      if (error) {
        sendPage(400, 'Sign-in failed', 'Databricks rejected the sign-in. Return to VS Code for details.');
        finish(new OAuthError(`Databricks returned ${error}: ${params.get('error_description') ?? 'no description'}`));
        return;
      }
      if (!code) {
        response.writeHead(400).end();
        return;
      }
      // A stale browser tab replaying an older challenge is the failure this guards.
      if (state !== expectedState) {
        sendPage(400, 'Sign-in failed', 'This sign-in link is stale. Start the sign-in again from VS Code.');
        finish(new OAuthError('OAuth state did not match. Start the sign-in again and use only the newest URL.'));
        return;
      }
      sendPage(200, 'Signed in', 'You can close this tab and return to VS Code.');
      finish(undefined, code);
    });

    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        finish(
          new OAuthError(
            `Port ${port} is already in use, so the sign-in redirect cannot be received. ` +
              'Close whatever is listening on it (often another Databricks or Azure CLI login) and try again.',
          ),
        );
        return;
      }
      finish(error);
    });

    const subscription = token.onCancellationRequested(() =>
      finish(new vscode.CancellationError()),
    );

    // 127.0.0.1 rather than all interfaces: the code must not be reachable off-box.
    server.listen(port, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      log.info(`Waiting for the OAuth redirect on http://127.0.0.1:${address.port}`);
    });
  });
}

export interface AuthorizeOptions {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string;
  redirectPort: number;
}

/**
 * Runs the full authorization-code + PKCE flow. Opens the system browser, then
 * races the loopback listener against a manual paste of the redirected URL so the
 * flow still completes where the browser cannot reach the listener (WSL without
 * port forwarding, dev containers, SSH remotes).
 */
export async function authorize(
  options: AuthorizeOptions,
  token: vscode.CancellationToken,
): Promise<TokenResponse> {
  const pkce = createPkce();
  const state = crypto.randomBytes(16).toString('base64url');
  const redirectUri = `http://localhost:${options.redirectPort}`;

  const authorizeUrl = new URL(options.authorizeUrl);
  authorizeUrl.searchParams.set('client_id', options.clientId);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('scope', options.scopes);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', pkce.challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  const listener = listenForCode(options.redirectPort, state, token);
  // Losing the race must not surface as an unhandled rejection.
  listener.catch(() => undefined);

  await vscode.env.openExternal(vscode.Uri.parse(authorizeUrl.toString()));
  log.info('Opened the Databricks sign-in page in the browser.');

  const code = await Promise.race([
    listener,
    promptForRedirectedUrl(state, token),
  ]);

  return await exchangeCode(options, code, pkce.verifier, redirectUri);
}

/**
 * Fallback path: the user copies the address bar after being redirected. Resolves
 * only on a valid paste so it never beats a working loopback listener.
 */
async function promptForRedirectedUrl(
  expectedState: string,
  token: vscode.CancellationToken,
): Promise<string> {
  const choice = await vscode.window.showInformationMessage(
    'Complete the Databricks sign-in in your browser.',
    { modal: false },
    'Paste redirect URL instead',
  );
  if (choice !== 'Paste redirect URL instead' || token.isCancellationRequested) {
    // Never resolves: let the loopback listener decide the outcome.
    return await new Promise<string>(() => undefined);
  }

  for (;;) {
    const pasted = await vscode.window.showInputBox({
      title: 'Databricks AI Gateway sign-in',
      prompt: `Paste the full localhost URL your browser was redirected to (it starts with http://localhost).`,
      placeHolder: 'http://localhost:8020/?code=...&state=...',
      ignoreFocusOut: true,
      password: true,
      validateInput: (value) => validateRedirect(value, expectedState),
    });
    if (pasted === undefined) {
      return await new Promise<string>(() => undefined);
    }
    const code = new URL(pasted.trim()).searchParams.get('code');
    if (code) {
      return code;
    }
  }
}

/** Exported for tests. Returns an error message, or undefined when the paste is usable. */
export function validateRedirect(value: string, expectedState: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'Paste the URL your browser was redirected to.';
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'That is not a URL.';
  }
  if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    return 'The redirect URL must point at localhost.';
  }
  const error = parsed.searchParams.get('error');
  if (error) {
    return `Databricks reported an error: ${error}`;
  }
  if (!parsed.searchParams.get('code')) {
    return 'That URL carries no authorization code.';
  }
  if (parsed.searchParams.get('state') !== expectedState) {
    return 'That URL belongs to an older sign-in attempt. Start again and use the newest link.';
  }
  return undefined;
}

async function exchangeCode(
  options: AuthorizeOptions,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: options.clientId,
    code_verifier: verifier,
  });
  return await postToken(options.tokenUrl, body, 'exchange the authorization code');
}

export async function refresh(
  tokenUrl: string,
  clientId: string,
  refreshToken: string,
  scopes: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    scope: scopes,
  });
  return await postToken(tokenUrl, body, 'refresh the Databricks token');
}

async function postToken(
  tokenUrl: string,
  body: URLSearchParams,
  action: string,
): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new OAuthError(`Could not reach the Databricks token endpoint to ${action}: ${describe(error)}`);
  }

  const text = await response.text();
  if (!response.ok) {
    // The body can echo the submitted grant, so report only the OAuth error code.
    let detail = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: unknown; error_description?: unknown };
      if (typeof parsed.error === 'string') {
        detail = parsed.error;
        if (typeof parsed.error_description === 'string') {
          detail += `: ${parsed.error_description}`;
        }
      }
    } catch {
      // Keep the status-only detail.
    }
    throw new OAuthError(`Databricks refused to ${action} (${detail}).`);
  }

  let payload: {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    throw new OAuthError(`The Databricks token endpoint returned a non-JSON response while trying to ${action}.`);
  }

  const accessToken = payload.access_token;
  if (typeof accessToken !== 'string' || !accessToken || /\s/.test(accessToken)) {
    throw new OAuthError(`The Databricks token endpoint returned no usable access token while trying to ${action}.`);
  }

  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : undefined;
  const expiresAt = expiresIn
    ? Date.now() + expiresIn * 1000
    : jwtExpiry(accessToken) ?? Date.now() + 5 * 60_000;

  return {
    accessToken,
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : undefined,
    expiresAt,
  };
}

/** Best-effort `exp` read. Falls back to a short TTL rather than trusting a long one. */
function jwtExpiry(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) {
    return undefined;
  }
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: unknown };
    if (typeof claims.exp === 'number' && Number.isFinite(claims.exp)) {
      const expiresAt = claims.exp * 1000;
      return expiresAt > Date.now() ? expiresAt : undefined;
    }
  } catch {
    // Unparseable payload: treat as no expiry hint.
  }
  return undefined;
}

export function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
