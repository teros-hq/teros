import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminCatalogGet: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Get the full catalog detail of a single MCA (app): complete description, ' +
    'auth configuration, secrets requirements, and the full tool list with their ' +
    'schemas. Use admin-catalog-list first to find the mcaId. Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      mcaId: {
        type: 'string',
        description: 'The MCA identifier, e.g. "mca.teros.github" (from admin-catalog-list).',
      },
    },
    required: ['mcaId'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.catalog-get', { mcaId: args.mcaId });
  },
};
