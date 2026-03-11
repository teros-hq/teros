import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';

export const search: ToolConfig = {
  description:
    'Search for pages and databases by title. Searches across all content shared with the integration.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query text',
      },
      filter: {
        type: 'string',
        description: "Filter results by type: 'page' or 'database' (optional)",
        enum: ['page', 'database'],
      },
      sort: {
        type: 'string',
        description: "Sort results by: 'last_edited_time' (optional, descending)",
        enum: ['last_edited_time'],
      },
    },
    required: ['query'],
  },
  handler: async (args, context) => {
    const client = await getNotionClient(context);

    const { query, filter, sort } = args as {
      query: string;
      filter?: 'page' | 'database';
      sort?: 'last_edited_time';
    };

    const searchParams: any = { query };

    if (filter) {
      searchParams.filter = {
        value: filter,
        property: 'object',
      };
    }

    if (sort) {
      searchParams.sort = {
        direction: 'descending',
        timestamp: sort,
      };
    }

    const response = await client.search(searchParams);
    return response;
  },
};
