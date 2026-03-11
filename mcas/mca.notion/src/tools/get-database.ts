import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';

export const getDatabase: ToolConfig = {
  description: 'Retrieve a database by its ID. Returns database schema and properties.',
  parameters: {
    type: 'object',
    properties: {
      databaseId: {
        type: 'string',
        description: 'The ID of the database',
      },
    },
    required: ['databaseId'],
  },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const { databaseId } = args as { databaseId: string };

    const database = await client.databases.retrieve({ database_id: databaseId });
    return database;
  },
};
