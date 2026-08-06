import type { ToolConfig } from '@teros/mca-sdk';
import { getHomeyApi, getSecrets, withTokenRefresh } from '../lib';

export const getUser: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get authenticated user information from Homey',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const secrets = await getSecrets(context);

    return withTokenRefresh(secrets, context, async (sec) => {
      const api = await getHomeyApi(sec);
      const user = await api.users.getUsers();
      return JSON.stringify(user, null, 2);
    });
  },
};
