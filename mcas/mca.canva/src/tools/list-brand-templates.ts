import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { canvaRequest } from '../lib';

export const listBrandTemplates: ToolConfig = {
  description: 'List brand templates (requires Canva Enterprise).',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
      },
      ownership: {
        type: 'string',
      },
      continuation: {
        type: 'string',
      },
    },
  },
  handler: async (args, context) => {
    const { query, ownership, continuation } = args as {
      query?: string;
      ownership?: string;
      continuation?: string;
    };

    const params = new URLSearchParams();
    if (query) params.append('query', query);
    if (ownership) params.append('ownership', ownership);
    if (continuation) params.append('continuation', continuation);

    const queryString = params.toString();
    return canvaRequest(context, `/brand-templates${queryString ? `?${queryString}` : ''}`);
  },
};
