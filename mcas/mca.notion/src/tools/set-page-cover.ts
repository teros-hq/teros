import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';

export const setPageCover: ToolConfig = {
  description: "Set or update a page's cover image from an external URL.",
  parameters: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'The ID of the page',
      },
      coverUrl: {
        type: 'string',
        description: 'URL of the cover image',
      },
    },
    required: ['pageId', 'coverUrl'],
  },
  handler: async (args, context) => {
    const client = await getNotionClient(context);

    const { pageId, coverUrl } = args as {
      pageId: string;
      coverUrl: string;
    };

    const page = await client.pages.update({
      page_id: pageId,
      cover: {
        type: 'external',
        external: { url: coverUrl },
      } as any,
    });

    return page;
  },
};
