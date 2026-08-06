import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest, formatEngagement } from '../lib';

export const listEngagements: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List HubSpot engagements (calls, emails, meetings, notes, tasks). Params: type (call|email|meeting|note|task), limit?, after?',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        description: 'Engagement type.',
        enum: ['call', 'email', 'meeting', 'note', 'task'],
      },
      limit: { type: 'number', description: 'Results per page. Min 1, max 100, default 50.' },
      after: { type: 'string', description: 'Pagination cursor.' },
      properties: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional properties to include.',
      },
    },
    required: ['type'],
  },
  handler: async (args, context) => {
    const { type, limit = 50, after, properties } = args as {
      type: 'call' | 'email' | 'meeting' | 'note' | 'task';
      limit?: number;
      after?: string;
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

    const params: Record<string, any> = {
      limit: Math.min(Math.max(limit, 1), 100),
    };
    if (after) params.after = after;

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

    params.properties = allProps.join(',');

    const data = (await hubspotRequest(context, `/crm/v3/objects/${objectType}`, { params })) as any;

    return {
      engagements: (data.results ?? []).map(formatEngagement),
      total: data.results?.length ?? 0,
      hasMore: !!data.paging?.next?.after,
      nextCursor: data.paging?.next?.after ?? null,
    };
  },
};
