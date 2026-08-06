import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest } from '../lib';

export const deleteEngagement: ToolConfig = {
  annotations: { readOnlyHint: false, irreversible: true },
  description:
    'Archive (soft delete) a HubSpot engagement. Params: type (call|email|meeting|note|task), engagementId',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        description: 'Engagement type.',
        enum: ['call', 'email', 'meeting', 'note', 'task'],
      },
      engagementId: { type: 'string', description: 'HubSpot engagement ID to archive.' },
    },
    required: ['type', 'engagementId'],
  },
  handler: async (args, context) => {
    const { type, engagementId } = args as {
      type: 'call' | 'email' | 'meeting' | 'note' | 'task';
      engagementId: string;
    };

    const engagementTypeMap: Record<string, string> = {
      call: 'calls',
      email: 'emails',
      meeting: 'meetings',
      note: 'notes',
      task: 'tasks',
    };

    const objectType = engagementTypeMap[type];

    await hubspotRequest(
      context,
      `/crm/v3/objects/${objectType}/${encodeURIComponent(engagementId)}`,
      { method: 'DELETE' },
    );

    return { success: true, engagementId, type };
  },
};
