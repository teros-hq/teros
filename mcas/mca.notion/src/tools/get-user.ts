import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';

export const getUser: ToolConfig = {
  description: 'Retrieve a user by ID.',
  parameters: {
    type: 'object',
    properties: {
      userId: {
        type: 'string',
        description: 'The ID of the user',
      },
    },
    required: ['userId'],
  },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const { userId } = args as { userId: string };

    const user = await client.users.retrieve({ user_id: userId });
    return user;
  },
};
