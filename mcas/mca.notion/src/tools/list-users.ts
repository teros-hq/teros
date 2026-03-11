import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';

export const listUsers: ToolConfig = {
  description: 'List all users in the workspace.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const client = await getNotionClient(context);
    const users = await client.users.list({});
    return users;
  },
};
