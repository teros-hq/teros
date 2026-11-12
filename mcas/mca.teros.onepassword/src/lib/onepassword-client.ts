/**
 * 1Password client — thin wrapper around the official @1password/sdk.
 *
 * Design notes:
 * - The SDK authenticates a Service Account token against 1Password's hosted
 *   endpoint (ent.1password.com) using an encrypted session protocol. It is
 *   NOT plain REST against connect.1password.com — the SA protocol is opaque,
 *   so we use the official SDK rather than reimplementing the session crypto.
 * - `getClient(context)` resolves the user secret OP_SERVICE_ACCOUNT_TOKEN and
 *   builds (and caches) an SDK client per token. The factory is injectable so
 *   tests can stub the SDK without touching the network.
 * - READ-ONLY by design: this wrapper only exposes vaults.list, items.list and
 *   items.get. No create/update/delete surface is reachable through it.
 */

import type { ToolContext } from '@teros/mca-sdk';

// The SDK ships its own types; import them loosely to avoid coupling our
// build to SDK internals (the SDK is a runtime dependency of this MCA only).
// biome-ignore lint/suspicious/noExplicitAny: SDK client shape is opaque to us
export type SdkClient = any;

export interface OnePasswordSecrets {
  OP_SERVICE_ACCOUNT_TOKEN?: string;
}

/** Minimal SDK surface we depend on (subset of VaultsApi / ItemsApi). */
export interface OnePasswordApi {
  vaults: {
    list(): Promise<
      Array<{
        id: string;
        title: string;
        description: string;
        vaultType: string;
        activeItemCount: number;
        contentVersion: number;
        attributeVersion: number;
        createdAt: Date | string;
        updatedAt: Date | string;
      }>
    >;
  };
  items: {
    list(
      vaultId: string,
      ...filters: unknown[]
    ): Promise<
      Array<{
        id: string;
        title: string;
        category: string;
        vaultId: string;
        tags: string[];
        state: string;
        createdAt: Date | string;
        updatedAt: Date | string;
      }>
    >;
    get(
      vaultId: string,
      itemId: string,
    ): Promise<{
      id: string;
      title: string;
      category: string;
      vaultId: string;
      fields: Array<{
        id: string;
        title: string;
        sectionId?: string;
        fieldType: string;
        value: string;
      }>;
      sections: Array<{ id: string; title: string }>;
      notes: string;
      tags: string[];
      version: number;
      createdAt: Date | string;
      updatedAt: Date | string;
    }>;
  };
}

// =============================================================================
// CLIENT FACTORY (injectable for tests)
// =============================================================================

/**
 * Builds an SDK client from a Service Account token. Overridden in tests to
 * avoid network calls; production uses the real `@1password/sdk`.
 */
export let clientFactory: (token: string) => Promise<SdkClient> = async (
  token: string,
) => {
  const sdk = (await import('@1password/sdk')) as {
    createClient: (config: {
      auth: string;
      integrationName: string;
      integrationVersion: string;
    }) => Promise<SdkClient>;
  };
  return sdk.createClient({
    auth: token,
    integrationName: 'Teros Platform',
    integrationVersion: '1.0.0',
  });
};

/** Replace the client factory (tests only). */
export function setClientFactory(
  factory: (token: string) => Promise<SdkClient>,
): void {
  clientFactory = factory;
}

// =============================================================================
// CLIENT RESOLUTION
// =============================================================================

const clientCache = new Map<string, SdkClient>();

/**
 * Resolve the 1Password SDK client for the current app instance.
 *
 * Throws a descriptive, user-actionable error when the Service Account token
 * is missing — the message tells the user exactly where to set it.
 */
export async function getClient(context: ToolContext): Promise<OnePasswordApi> {
  const secrets = (await context.getUserSecrets()) as OnePasswordSecrets;
  const token = secrets.OP_SERVICE_ACCOUNT_TOKEN;

  if (!token) {
    throw new Error(
      '1Password Service Account token not configured. Please set your OP_SERVICE_ACCOUNT_TOKEN in the app settings (see the 1Password MCA README for the 3-step setup).',
    );
  }

  let client = clientCache.get(token);
  if (!client) {
    client = await clientFactory(token);
    clientCache.set(token, client);
  }

  return client as unknown as OnePasswordApi;
}

/** Test hook: clear the client cache between tests. */
export function clearClientCache(): void {
  clientCache.clear();
}
