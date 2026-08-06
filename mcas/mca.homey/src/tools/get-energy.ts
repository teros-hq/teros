import type { ToolConfig } from '@teros/mca-sdk';
import { getHomeyApi, getSecrets, withTokenRefresh } from '../lib';

export const getEnergy: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get live energy report from Homey including current power usage and generation across the home',
  parameters: {
    type: 'object',
    properties: {
      zone: {
        type: 'string',
        description: 'Optional zone ID to filter energy data for a specific zone',
      },
    },
  },
  handler: async (args, context) => {
    const secrets = await getSecrets(context);

    return withTokenRefresh(secrets, context, async (sec) => {
      const api = await getHomeyApi(sec);

      const opts: any = {};
      if (args.zone) {
        opts.zone = args.zone as string;
      }

      const liveReport = await api.energy.getLiveReport(opts);

      return JSON.stringify(liveReport, null, 2);
    });
  },
};
