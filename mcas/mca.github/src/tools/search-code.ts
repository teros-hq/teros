import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const searchCode: ToolConfig = {
  description: 'Search for code across GitHub repositories',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (e.g., "addClass in:file language:js repo:jquery/jquery")' },
      per_page: { type: 'number', description: 'Results per page (default: 30, max: 100)' },
    },
    required: ['query'],
  },
  handler: async (args, context) => {
    const { query, per_page } = args as { query: string; per_page?: number };
    return await githubRequest(context, '/search/code', { params: { q: query, per_page } });
  },
};
