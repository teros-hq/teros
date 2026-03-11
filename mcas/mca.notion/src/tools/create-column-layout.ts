import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';

export const createColumnLayout: ToolConfig = {
  description: 'Create a column layout with multiple columns containing blocks.',
  parameters: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'The ID of the page to add columns to',
      },
      columns: {
        type: 'array',
        description: 'Array of column blocks. Each column contains an array of blocks.',
        items: { type: 'object' },
      },
    },
    required: ['pageId', 'columns'],
  },
  handler: async (args, context) => {
    const client = await getNotionClient(context);

    const { pageId, columns } = args as {
      pageId: string;
      columns: any[][];
    };

    const columnBlocks = columns.map((columnContent) => ({
      object: 'block',
      type: 'column',
      column: {
        children: columnContent,
      },
    }));

    const columnListBlock = {
      object: 'block',
      type: 'column_list',
      column_list: {
        children: columnBlocks,
      },
    };

    const response = await client.blocks.children.append({
      block_id: pageId,
      children: [columnListBlock] as any,
    });

    return response;
  },
};
