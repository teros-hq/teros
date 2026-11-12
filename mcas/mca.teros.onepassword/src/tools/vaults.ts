import { getClient } from '../lib/index.js';
import type { ToolConfig } from '@teros/mca-sdk';

/**
 * list-vaults — vaults the Service Account can access.
 *
 * Read-only. Returns vault id, title, description, type and item count so the
 * agent can pick the right vault before listing items.
 */
export const listVaults: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List the 1Password vaults accessible to the connected Service Account. Returns vault id, title, description, type and active item count. Use this first to find the vault id for list-items.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const client = await getClient(context);
    const vaults = await client.vaults.list();

    const curated = vaults.map((v) => ({
      id: v.id,
      title: v.title,
      description: v.description,
      vaultType: v.vaultType,
      activeItemCount: v.activeItemCount,
      updatedAt: v.updatedAt instanceof Date ? v.updatedAt.toISOString() : v.updatedAt,
    }));

    return {
      vaults: curated,
      count: curated.length,
    };
  },
};
