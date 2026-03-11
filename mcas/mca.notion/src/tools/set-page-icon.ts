import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';

export const setPageIcon: ToolConfig = {
  description: "Set or update a page's icon (emoji or external image URL).",
  parameters: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'The ID of the page',
      },
      iconType: {
        type: 'string',
        description: "Type of icon: 'emoji' or 'external'",
        enum: ['emoji', 'external'],
      },
      icon: {
        type: 'string',
        description: "Emoji character (if iconType is 'emoji') or URL (if iconType is 'external')",
      },
    },
    required: ['pageId', 'iconType', 'icon'],
  },
  handler: async (args, context) => {
    const client = await getNotionClient(context);

    const { pageId, iconType, icon } = args as {
      pageId: string;
      iconType: 'emoji' | 'external';
      icon: string;
    };

    const iconObj =
      iconType === 'emoji'
        ? { type: 'emoji', emoji: icon }
        : { type: 'external', external: { url: icon } };

    const page = await client.pages.update({
      page_id: pageId,
      icon: iconObj as any,
    });

    return page;
  },
};
