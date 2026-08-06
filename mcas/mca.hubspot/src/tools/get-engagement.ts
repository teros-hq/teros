import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest, formatEngagement } from '../lib';

export const getEngagement: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Retrieve a HubSpot engagement by ID. Params: type (call|email|meeting|note|task), engagementId',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        description: 'Engagement type.',
        enum: ['call', 'email', 'meeting', 'note', 'task'],
      },
      engagementId: { type: 'string', description: 'HubSpot engagement ID.' },
      properties: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional properties to include.',
      },
    },
    required: ['type', 'engagementId'],
  },
  handler: async (args, context) => {
    const { type, engagementId, properties } = args as {
      type: 'call' | 'email' | 'meeting' | 'note' | 'task';
      engagementId: string;
      properties?: string[];
    };

    const engagementTypeMap: Record<string, string> = {
      call: 'calls',
      email: 'emails',
      meeting: 'meetings',
      note: 'notes',
      task: 'tasks',
    };

    const objectType = engagementTypeMap[type];

    const defaultProps = ['hs_createdate', 'hs_lastmodifieddate'];
    const typeSpecificProps: Record<string, string[]> = {
      call: ['hs_call_title', 'hs_call_body', 'hs_call_status', 'hs_call_direction', 'hs_call_duration', 'hs_timestamp'],
      email: ['hs_email_subject', 'hs_email_text', 'hs_email_status', 'hs_email_direction', 'hs_timestamp'],
      meeting: ['hs_meeting_title', 'hs_meeting_body', 'hs_meeting_status', 'hs_meeting_start_time', 'hs_timestamp'],
      note: ['hs_note_body', 'hs_timestamp'],
      task: ['hs_task_subject', 'hs_task_body', 'hs_task_status', 'hs_task_priority', 'hs_task_type', 'hs_timestamp'],
    };

    const allProps = properties
      ? [...new Set([...defaultProps, ...(typeSpecificProps[type] || []), ...properties])]
      : [...defaultProps, ...(typeSpecificProps[type] || [])];

    const data = (await hubspotRequest(
      context,
      `/crm/v3/objects/${objectType}/${encodeURIComponent(engagementId)}`,
      { params: { properties: allProps.join(',') } },
    )) as any;

    return formatEngagement(data);
  },
};
