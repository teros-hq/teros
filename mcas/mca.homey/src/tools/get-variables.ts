import type { ToolConfig } from '@teros/mca-sdk';
import { getHomeyApi, getSecrets, withTokenRefresh } from '../lib';

export const getVariables: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List all logic variables configured in Homey. Logic variables are used in flows/automations for state tracking.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const secrets = await getSecrets(context);

    return withTokenRefresh(secrets, context, async (sec) => {
      const api = await getHomeyApi(sec);
      const variables = await api.logic.getVariables();

      const varList = Object.values(variables).map((v: any) => ({
        id: v.id,
        name: v.name,
        type: v.type,
        value: v.value,
      }));

      return JSON.stringify(varList, null, 2);
    });
  },
};
