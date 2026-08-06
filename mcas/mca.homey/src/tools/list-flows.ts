import type { ToolConfig } from '@teros/mca-sdk';
import { getHomeyApi, getSecrets, withTokenRefresh } from '../lib';

export const listFlows: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List all flows (automations) configured in Homey',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const secrets = await getSecrets(context);

    return withTokenRefresh(secrets, context, async (sec) => {
      const api = await getHomeyApi(sec);
      const flows = await api.flow.getFlows();

      const flowList = Object.values(flows).map((flow: any) => ({
        id: flow.id,
        name: flow.name,
        enabled: flow.enabled,
        folder: flow.folder,
      }));

      return JSON.stringify(flowList, null, 2);
    });
  },
};
