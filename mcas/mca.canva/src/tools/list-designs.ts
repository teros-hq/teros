import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { canvaRequest } from '../lib';

export const listDesigns: ToolConfig = {
  description: "List all designs in the user's account. Supports search, filtering, and sorting.",
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search term to filter designs',
      },
      ownership: {
        type: 'string',
        enum: ['any', 'owned', 'shared'],
        description: 'Filter by ownership',
      },
      sortBy: {
        type: 'string',
        enum: [
          'relevance',
          'modified_descending',
          'modified_ascending',
          'title_descending',
          'title_ascending',
        ],
      },
      limit: {
        type: 'number',
        description: 'Max results (default: 25, max: 100)',
      },
      continuation: {
        type: 'string',
        description: 'Pagination token',
      },
    },
  },
  handler: async (args, context) => {
    const { query, ownership, sortBy, limit, continuation } = args as {
      query?: string;
      ownership?: string;
      sortBy?: string;
      limit?: number;
      continuation?: string;
    };

    const params = new URLSearchParams();
    if (query) params.append('query', query);
    if (ownership) params.append('ownership', ownership);
    if (sortBy) params.append('sort_by', sortBy);
    if (limit) params.append('limit', String(limit));
    if (continuation) params.append('continuation', continuation);

    const queryString = params.toString();
    return canvaRequest(context, `/designs${queryString ? `?${queryString}` : ''}`);
  },
};
