import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { AuthManager } from './auth';
import { describe } from './oauth';
import { log } from './log';

/**
 * A loopback endpoint that hands the current gateway token to local helper
 * processes — specifically Claude Code's `apiKeyHelper`, which runs outside the
 * extension host and so cannot read VS Code's SecretStorage.
 *
 * The token is minted on demand and never written to disk. The listener is bound
 * to 127.0.0.1 and additionally gated on a per-session shared secret, so another
 * user on the same machine cannot read tokens out of it even though the port is
 * local.
 */
export class TokenService {
  private server: http.Server | undefined;
  private readonly secret = crypto.randomBytes(32).toString('base64url');
  private port = 0;

  constructor(private readonly auth: AuthManager) {}

  get endpoint(): string | undefined {
    return this.port ? `http://127.0.0.1:${this.port}/token` : undefined;
  }

  get sharedSecret(): string {
    return this.secret;
  }

  async start(requestedPort: number): Promise<void> {
    if (this.server) {
      return;
    }
    const server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(requestedPort, '127.0.0.1', () => {
        server.removeListener('error', reject);
        this.port = (server.address() as AddressInfo).port;
        log.info(`Token service listening on 127.0.0.1:${this.port}.`);
        resolve();
      });
    });

    server.on('error', (error) => log.error(`Token service error: ${describe(error)}`));
  }

  dispose(): void {
    this.server?.close();
    this.server = undefined;
    this.port = 0;
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const send = (status: number, body: string, contentType = 'text/plain; charset=utf-8') => {
      response.writeHead(status, {
        'Content-Type': contentType,
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      });
      response.end(body);
    };

    if (request.method !== 'GET') {
      send(405, 'method not allowed');
      return;
    }
    const path = (request.url ?? '/').split('?')[0];
    if (path !== '/token') {
      send(404, 'not found');
      return;
    }
    if (!this.authorized(request)) {
      send(401, 'unauthorized');
      return;
    }

    try {
      const token = await this.auth.getAccessToken();
      // Plain text and no trailing newline: Claude Code uses the helper's stdout
      // verbatim as the credential.
      send(200, token);
    } catch (error) {
      log.warn(`Token service could not mint a token: ${describe(error)}`);
      send(503, 'no databricks credential; sign in from VS Code');
    }
  }

  private authorized(request: http.IncomingMessage): boolean {
    const header = request.headers.authorization ?? '';
    const expected = `Bearer ${this.secret}`;
    const provided = Buffer.from(header);
    const wanted = Buffer.from(expected);
    // Length check first: timingSafeEqual throws on a length mismatch.
    return provided.length === wanted.length && crypto.timingSafeEqual(provided, wanted);
  }
}
