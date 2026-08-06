import type { ToolConfig } from '@teros/mca-sdk';
import { getHomeyApi, getSecrets, withTokenRefresh } from '../lib';

export const getSystemInfo: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get Homey system information including firmware version, model, uptime, Wi-Fi status, and more',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const secrets = await getSecrets(context);

    return withTokenRefresh(secrets, context, async (sec) => {
      const api = await getHomeyApi(sec);
      const info = await api.system.getInfo();
      return JSON.stringify(info, null, 2);
    });
  },
};
