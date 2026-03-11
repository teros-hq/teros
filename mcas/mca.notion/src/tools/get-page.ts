import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';

export const getPage: ToolConfig = {
  description: 'Retrieve a page by its ID. Returns page properties and metadata.',
  parameters: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'The ID of the page to retrieve (can be with or without dashes)',
      },
    },
    required: ['pageId'],
  },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const { pageId } = args as { pageId: string };

    const page = await client.pages.retrieve({ page_id: pageId });
    return page;
  },
};
