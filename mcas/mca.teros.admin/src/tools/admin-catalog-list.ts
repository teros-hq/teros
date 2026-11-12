import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminCatalogList: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'List available MCAs in the catalog as lightweight summaries (id, name, ' +
    'description, category, tool count, keywords, availability). Does NOT return ' +
    'tool schemas — use admin-catalog-get for the full detail of one app. ' +
    'Supports free-text search across names, descriptions, keywords and tool names, ' +
    'and category filtering. Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      search: {
        type: 'string',
        description:
          'Free-text search (case-insensitive substring) across MCA id, name, ' +
          'description, tagline, category, keywords and tool names (optional).',
      },
      category: {
        type: 'string',
        description:
          'Filter by category (optional, e.g. "productivity", "communication", "development", "google", "microsoft").',
      },
      includeHidden: {
        type: 'boolean',
        description: 'Include hidden MCAs in the results (default false).',
      },
    },
    required: [],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.catalog-list', {
      search: args.search,
      category: args.category,
      includeHidden: args.includeHidden,
    });
  },
};
