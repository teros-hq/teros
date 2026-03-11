import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';

export const getMe: ToolConfig = {
  description: 'Retrieve the bot user information (your integration).',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const client = await getNotionClient(context);
    const bot = await client.users.me({});
    return bot;
  },
};
