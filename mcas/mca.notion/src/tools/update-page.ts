import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';

export const updatePage: ToolConfig = {
  description: 'Update page properties (title, status, etc.) or archive/restore the page.',
  parameters: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'The ID of the page to update',
      },
      properties: {
        type: 'object',
        description: 'Properties to update (depends on database schema)',
      },
      archived: {
        type: 'boolean',
        description: 'Archive or restore the page (optional)',
      },
    },
    required: ['pageId'],
  },
  handler: async (args, context) => {
    const client = await getNotionClient(context);

    const { pageId, properties, archived } = args as {
      pageId: string;
      properties?: Record<string, any>;
      archived?: boolean;
    };

    const updateParams: any = { page_id: pageId };

    if (properties) {
      updateParams.properties = properties;
    }

    if (archived !== undefined) {
      updateParams.archived = archived;
    }

    const page = await client.pages.update(updateParams);
    return page;
  },
};
