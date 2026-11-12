import type { ToolConfig } from '@teros/mca-sdk';
import { getHomeyApi, getSecrets, withTokenRefresh } from '../lib';

export const listFlows: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List all flows (automations) configured in Homey',
  parameters: {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        description: 'Filter by enabled state.',
      },
      search: {
        type: 'string',
        description: 'Search flow names (case-insensitive substring).',
      },
    },
  },
  handler: async (args, context) => {
    const secrets = await getSecrets(context);

    return withTokenRefresh(secrets, context, async (sec) => {
      const api = await getHomeyApi(sec);
      const flows = await api.flow.getFlows();

      let flowList = Object.values(flows).map((flow: any) => ({
        id: flow.id,
        name: flow.name,
        enabled: flow.enabled,
        folder: flow.folder,
        folderName: null,
        triggerCount: flow.triggers?.length || 0,
        conditionCount: flow.conditions?.length || 0,
        actionCount: flow.actions?.length || 0,
        triggers:
          flow.triggers?.map((t: any) => ({
            type: t.type,
            label: t.title || t.label || t.type,
          })) || [],
        conditions:
          flow.conditions?.map((c: any) => ({
            type: c.type,
            label: c.title || c.label || c.type,
          })) || [],
        actions:
          flow.actions?.map((a: any) => ({
            type: a.type,
            label: a.title || a.label || a.type,
          })) || [],
      }));

      // Apply filters
      if (typeof args.enabled === 'boolean') {
        flowList = flowList.filter((f) => f.enabled === args.enabled);
      }

      if (args.search) {
        const searchLower = String(args.search).toLowerCase();
        flowList = flowList.filter((f) =>
          f.name?.toLowerCase().includes(searchLower),
        );
      }

      return JSON.stringify(flowList, null, 2);
    });
  },
};
