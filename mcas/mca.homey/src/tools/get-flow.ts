import type { ToolConfig } from '@teros/mca-sdk';
import { getHomeyApi, getSecrets, withTokenRefresh } from '../lib';

export const getFlow: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get detailed information about a specific Homey flow by ID, including full triggers, conditions, and actions.',
  parameters: {
    type: 'object',
    properties: {
      flow_id: { type: 'string', description: 'Flow ID' },
    },
    required: ['flow_id'],
  },
  handler: async (args, context) => {
    const secrets = await getSecrets(context);

    return withTokenRefresh(secrets, context, async (sec) => {
      const api = await getHomeyApi(sec);
      const flows = await api.flow.getFlows();
      const flow = (flows as any)[args.flow_id as string];
      if (!flow) {
        return JSON.stringify({ error: `Flow not found: ${args.flow_id}` }, null, 2);
      }
      return JSON.stringify(flow, null, 2);
    });
  },
};
