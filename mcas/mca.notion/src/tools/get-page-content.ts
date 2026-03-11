import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { formatBlocksAsText, getAllBlocks, getNotionClient } from '../lib';

export const getPageContent: ToolConfig = {
  description:
    'Retrieve the full content/blocks of a page as formatted text. Set includeBlocks=true only when you need block IDs for editing operations.',
  parameters: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'The ID of the page',
      },
      includeBlocks: {
        type: 'boolean',
        description:
          'Include raw block data with IDs (default: false). Only set to true when you need to edit/insert blocks.',
      },
    },
    required: ['pageId'],
  },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const { pageId, includeBlocks = false } = args as { pageId: string; includeBlocks?: boolean };

    const blocks = await getAllBlocks(client, pageId);
    const textContent = formatBlocksAsText(blocks);

    if (includeBlocks) {
      return {
        textContent,
        blocks,
      };
    }

    return {
      textContent,
    };
  },
};
