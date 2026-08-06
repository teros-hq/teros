import type { ToolConfig } from '@teros/mca-sdk';
import { getHomeyApi, getSecrets, withTokenRefresh } from '../lib';

export const triggerFlow: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Trigger (run) a Homey flow by its ID',
  parameters: {
    type: 'object',
    properties: {
      flow_id: {
        type: 'string',
        description: 'Flow ID to trigger',
      },
    },
    required: ['flow_id'],
  },
  handler: async (args, context) => {
    const secrets = await getSecrets(context);

    return withTokenRefresh(secrets, context, async (sec) => {
      const api = await getHomeyApi(sec);
      const flow = await api.flow.getFlow({ id: args.flow_id as string });
      await flow.trigger();

      return JSON.stringify(
        {
          success: true,
          flow_id: args.flow_id,
          flow_name: flow.name,
          message: 'Flow triggered successfully',
        },
        null,
        2,
      );
    });
  },
};
