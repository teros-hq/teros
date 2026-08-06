/**
 * Linear API Client Manager
 *
 * Manages authentication and API requests for the Linear SDK (@linear/sdk).
 * Uses a Personal API Key (API_KEY) from user secrets.
 */

import { LinearClient } from '@linear/sdk';
import type { ToolContext } from '@teros/mca-sdk';

// =============================================================================
// TYPES
// =============================================================================

export interface LinearSecrets {
  API_KEY?: string;
}

// =============================================================================
// SINGLETON STATE
// =============================================================================

let cachedClient: LinearClient | null = null;
let cachedKey: string | null = null;

// =============================================================================
// CLIENT INITIALIZATION
// =============================================================================

/**
 * Get or create a Linear client with credentials from the tool context.
 * Caches the client per-API-key so successive tool calls reuse the same
 * authenticated instance.
 */
export async function getLinearClient(context: ToolContext): Promise<LinearClient> {
  const userSecrets = (await context.getUserSecrets()) as LinearSecrets;
  const apiKey = userSecrets.API_KEY;

  if (!apiKey) {
    throw new Error(
      'Linear API key not configured. Please configure it in app settings.',
    );
  }

  if (cachedClient && cachedKey === apiKey) {
    return cachedClient;
  }

  cachedClient = new LinearClient({ apiKey });
  cachedKey = apiKey;
  return cachedClient;
}

/**
 * Validate Linear credentials by making a real API call that exercises the
 * workspace scope of the key (not just `client.viewer` which the SDK may
 * resolve lazily without a network round-trip).
 */
export async function validateCredentials(context: ToolContext): Promise<void> {
  const client = await getLinearClient(context);
  await client.teams({ first: 1 });
}
