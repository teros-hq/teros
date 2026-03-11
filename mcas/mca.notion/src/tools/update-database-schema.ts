import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';

export const updateDatabaseSchema: ToolConfig = {
  description:
    'Update database schema by adding, modifying, or removing properties (columns). To remove a property, set its value to null.',
  parameters: {
    type: 'object',
    properties: {
      databaseId: {
        type: 'string',
        description: 'The ID of the database to update',
      },
      properties: {
        type: 'object',
        description: 'Properties to add or modify. To remove a property, set its value to null.',
      },
      title: {
        type: 'string',
        description: 'New database title (optional)',
      },
      description: {
        type: 'string',
        description: 'New database description (optional)',
      },
    },
    required: ['databaseId', 'properties'],
  },
  handler: async (args, context) => {
    const client = await getNotionClient(context);

    const { databaseId, properties, title, description } = args as {
      databaseId: string;
      properties: Record<string, any>;
      title?: string;
      description?: string;
    };

    const updateParams: any = {
      database_id: databaseId,
      properties,
    };

    if (title) {
      updateParams.title = [{ text: { content: title } }];
    }

    if (description) {
      updateParams.description = [{ text: { content: description } }];
    }

    const database = await client.databases.update(updateParams);
    return database;
  },
};
