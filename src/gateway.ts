import Anthropic from '@anthropic-ai/sdk';
import { CODING_AGENT_HEADER, anthropicBaseUrl } from './config';

/**
 * Builds the client every gateway call goes through.
 *
 * Shared deliberately: a caller that hand-rolls its own request tests a
 * different thing than the real chat path does. The SDK supplies headers the
 * gateway requires — `anthropic-version` above all — so a bare `fetch` to the
 * same URL can fail for reasons that have nothing to do with the request.
 */
export function createGatewayClient(
  workspaceOrigin: string,
  accessToken: string,
  options: { timeoutMs?: number; maxRetries?: number } = {},
): Anthropic {
  return new Anthropic({
    baseURL: anthropicBaseUrl(workspaceOrigin),
    // The gateway authenticates with the Databricks OAuth token as a bearer
    // credential; there is no Anthropic API key in this path.
    authToken: accessToken,
    apiKey: null,
    defaultHeaders: { [CODING_AGENT_HEADER]: 'true' },
    maxRetries: options.maxRetries ?? 2,
    timeout: options.timeoutMs ?? 10 * 60 * 1000,
  });
}
