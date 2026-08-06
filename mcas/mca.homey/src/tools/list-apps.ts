import type { ToolConfig } from '@teros/mca-sdk';
import { getHomeyApi, getSecrets, withTokenRefresh } from '../lib';

export const listApps: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List all apps installed on Homey. Useful for diagnostics and checking which integrations are active.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const secrets = await getSecrets(context);

    return withTokenRefresh(secrets, context, async (sec) => {
      const api = await getHomeyApi(sec);
      const apps = await api.apps.getApps();

      const appList = Object.values(apps).map((app: any) => ({
        id: app.id,
        name: app.name,
        version: app.version,
        enabled: app.enabled,
        origin: app.origin,
        channel: app.channel,
        autoupdate: app.autoupdate,
      }));

      return JSON.stringify(appList, null, 2);
    });
  },
};
