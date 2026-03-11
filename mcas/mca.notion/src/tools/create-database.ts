import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';

export const createDatabase: ToolConfig = {
  description: 'Create a new database as a child of a page.',
  parameters: {
    type: 'object',
    properties: {
      parentPageId: {
        type: 'string',
        description: 'Parent page ID',
      },
      title: {
        type: 'string',
        description: 'Database title',
      },
      properties: {
        type: 'object',
        description:
          'Database schema properties (e.g., {Name: {title: {}}, Status: {select: {options: [...]}}})',
      },
    },
    required: ['parentPageId', 'title', 'properties'],
  },
  handler: async (args, context) => {
    const client = await getNotionClient(context);

    const { parentPageId, title, properties } = args as {
      parentPageId: string;
      title: string;
      properties: Record<string, any>;
    };

    const database = await client.databases.create({
      parent: { page_id: parentPageId },
      title: [{ text: { content: title } }],
      properties,
    } as any);

    return database;
  },
};
