import type { ToolConfig } from '@teros/mca-sdk';
import { getHomeyApi, getSecrets, withTokenRefresh } from '../lib';

export const listNotifications: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List notifications from Homey (alerts, warnings, system messages)',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const secrets = await getSecrets(context);

    return withTokenRefresh(secrets, context, async (sec) => {
      const api = await getHomeyApi(sec);
      const notifications = await api.notifications.getNotifications();

      const notifList = Object.values(notifications).map((notif: any) => ({
        id: notif.id,
        excerpt: notif.excerpt,
        dateCreated: notif.dateCreated,
        ownerUri: notif.ownerUri,
      }));

      return JSON.stringify(notifList, null, 2);
    });
  },
};
