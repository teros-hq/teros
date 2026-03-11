import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const getUser: ToolConfig = {
  description: 'Get information about the authenticated user or a specific user',
  parameters: {
    type: 'object',
    properties: {
      username: { type: 'string', description: 'GitHub username (omit for authenticated user)' },
    },
  },
  handler: async (args, context) => {
    const { username } = args as { username?: string };
    const endpoint = username ? `/users/${username}` : '/user';
    return await githubRequest(context, endpoint);
  },
};
