import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';

export const createAdvancedBlocks: ToolConfig = {
  description:
    'Create advanced block types: callout with custom icon/color, toggle with children, synced blocks.',
  parameters: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'The ID of the page',
      },
      blockType: {
        type: 'string',
        description: "Type of advanced block: 'callout', 'toggle', 'synced_block'",
        enum: ['callout', 'toggle', 'synced_block'],
      },
      content: {
        type: 'object',
        description: 'Block configuration (depends on blockType)',
      },
    },
    required: ['pageId', 'blockType', 'content'],
  },
  handler: async (args, context) => {
    const client = await getNotionClient(context);

    const { pageId, blockType, content } = args as {
      pageId: string;
      blockType: 'callout' | 'toggle' | 'synced_block';
      content: Record<string, any>;
    };

    let block: any;

    switch (blockType) {
      case 'callout':
        block = {
          object: 'block',
          type: 'callout',
          callout: content,
        };
        break;
      case 'toggle':
        block = {
          object: 'block',
          type: 'toggle',
          toggle: content,
        };
        break;
      case 'synced_block':
        block = {
          object: 'block',
          type: 'synced_block',
          synced_block: content,
        };
        break;
      default:
        throw new Error(`Unknown block type: ${blockType}`);
    }

    const response = await client.blocks.children.append({
      block_id: pageId,
      children: [block],
    });

    return response;
  },
};
