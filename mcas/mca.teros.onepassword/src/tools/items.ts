import { getClient } from '../lib/index.js';
import type { ToolConfig } from '@teros/mca-sdk';

/**
 * list-items — items in a vault, with titles and categories.
 *
 * Read-only. Returns item id, title, category, tags and state so the agent
 * can locate the item (e.g. a Deepgram API credential) before reading fields.
 */
export const listItems: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List the items in a 1Password vault. Returns item id, title, category, tags and state (no field values). Use list-vaults to get the vault id, then this tool to find the item id for get-item-fields.',
  parameters: {
    type: 'object',
    properties: {
      vaultId: {
        type: 'string',
        description: 'The ID of the vault to list items from (get it from list-vaults).',
      },
      includeArchived: {
        type: 'boolean',
        description: 'Include archived items in the listing (default: false).',
        default: false,
      },
    },
    required: ['vaultId'],
  },
  handler: async (args, context) => {
    const vaultId = args.vaultId as string;
    const includeArchived = (args.includeArchived as boolean) ?? false;

    const client = await getClient(context);
    const items = await client.items.list(vaultId);

    const filtered = includeArchived ? items : items.filter((i) => i.state !== 'ARCHIVED');

    const curated = filtered.map((i) => ({
      id: i.id,
      title: i.title,
      category: i.category,
      tags: i.tags,
      state: i.state,
      updatedAt: i.updatedAt instanceof Date ? i.updatedAt.toISOString() : i.updatedAt,
    }));

    return {
      vaultId,
      items: curated,
      count: curated.length,
      archivedExcluded: !includeArchived && items.length !== filtered.length,
    };
  },
};

/**
 * get-item-fields — fields of an item, INCLUDING secret values.
 *
 * This is the point of the MCA: the agent reads the actual secret value (e.g.
 * an API key) so it can place it where needed (e.g. write
 * `.secrets/system/deepgram.json`). SECURITY: secret values must not be
 * logged or persisted beyond the requested action — the agent uses the value
 * and moves on. See README "Security".
 */
export const getItemFields: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get the fields of a 1Password item, including the values of secret fields (passwords, API keys, credentials). Use list-items to find the item id. SECURITY: treat returned secret values as sensitive — use them for the requested action (e.g. writing a secrets file) and do not echo, log or persist them anywhere else.',
  parameters: {
    type: 'object',
    properties: {
      vaultId: {
        type: 'string',
        description: 'The ID of the vault containing the item.',
      },
      itemId: {
        type: 'string',
        description: 'The ID of the item to read (get it from list-items).',
      },
    },
    required: ['vaultId', 'itemId'],
  },
  handler: async (args, context) => {
    const vaultId = args.vaultId as string;
    const itemId = args.itemId as string;

    const client = await getClient(context);
    const item = await client.items.get(vaultId, itemId);

    const sectionTitles = new Map<string, string>();
    for (const s of item.sections ?? []) {
      sectionTitles.set(s.id, s.title);
    }

    const fields = (item.fields ?? []).map((f) => ({
      id: f.id,
      title: f.title,
      section: f.sectionId ? (sectionTitles.get(f.sectionId) ?? f.sectionId) : null,
      fieldType: f.fieldType,
      value: f.value,
    }));

    return {
      id: item.id,
      title: item.title,
      category: item.category,
      vaultId: item.vaultId,
      tags: item.tags,
      fields,
      sections: (item.sections ?? []).map((s) => ({ id: s.id, title: s.title })),
      hasNotes: !!item.notes,
      version: item.version,
    };
  },
};
