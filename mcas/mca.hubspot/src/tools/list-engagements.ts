import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest, formatEngagement, formatTask } from '../lib';

// Status property per engagement type. Notes have no status property.
const STATUS_PROP: Record<string, string> = {
  call: 'hs_call_status',
  email: 'hs_email_status',
  meeting: 'hs_meeting_status',
  task: 'hs_task_status',
};

export const listEngagements: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List HubSpot engagements (calls, emails, meetings, notes, tasks). Params: type (call|email|meeting|note|task), limit?, after?, ownerId?, status?, properties?. ownerId filters by HubSpot owner (hubspot_owner_id) — use it for "my tasks/engagements"; owner IDs come from /crm/v3/owners. status filters by the type\'s status property (hs_task_status, hs_call_status, hs_email_status, hs_meeting_status; not supported for notes). When ownerId or status is provided the tool uses the search endpoint (POST /crm/v3/objects/{type}/search) because the plain list endpoint does not support server-side filtering.',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        description: 'Engagement type.',
        enum: ['call', 'email', 'meeting', 'note', 'task'],
      },
      limit: { type: 'number', description: 'Results per page. Min 1, max 100, default 50.' },
      after: { type: 'string', description: 'Pagination cursor (from a previous page).' },
      ownerId: {
        type: 'string',
        description: 'Filter by HubSpot owner ID (hubspot_owner_id), e.g. for "my tasks". Owner IDs come from /crm/v3/owners.',
      },
      status: {
        type: 'string',
        description:
          'Filter by status, e.g. NOT_STARTED | IN_PROGRESS | WAITING | COMPLETED for tasks. Mapped to the type\'s status property; not supported for notes.',
      },
      properties: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional properties to include.',
      },
    },
    required: ['type'],
  },
  handler: async (args, context) => {
    const { type, limit = 50, after, ownerId, status, properties } = args as {
      type: 'call' | 'email' | 'meeting' | 'note' | 'task';
      limit?: number;
      after?: string;
      ownerId?: string;
      status?: string;
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

    const defaultProps = ['hs_createdate', 'hs_lastmodifieddate', 'hubspot_owner_id'];
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

    // Tasks have their own formatter: formatEngagement never reads hs_task_*
    // properties, so tasks used to come back with subject/body/status null.
    const formatter = type === 'task' ? formatTask : formatEngagement;

    // The GET list endpoint has no server-side filtering. When an owner or
    // status filter is requested, switch to the search endpoint, which
    // supports filterGroups (same pattern as the search tool).
    const filters: Array<{ propertyName: string; operator: 'EQ'; value: string }> = [];
    if (ownerId) {
      filters.push({ propertyName: 'hubspot_owner_id', operator: 'EQ', value: ownerId });
    }
    if (status && STATUS_PROP[type]) {
      filters.push({ propertyName: STATUS_PROP[type], operator: 'EQ', value: status });
    }

    let data: any;

    if (filters.length > 0) {
      const body: Record<string, any> = {
        limit: Math.min(Math.max(limit, 1), 100),
        properties: allProps,
        filterGroups: [{ filters }],
      };
      // The search endpoint paginates with a numeric offset, not a cursor.
      const afterNum = after !== undefined ? Number(after) : NaN;
      if (Number.isFinite(afterNum)) body.after = afterNum;

      data = await hubspotRequest(context, `/crm/v3/objects/${objectType}/search`, {
        method: 'POST',
        body,
      });
    } else {
      const params: Record<string, any> = {
        limit: Math.min(Math.max(limit, 1), 100),
        properties: allProps.join(','),
      };
      if (after) params.after = after;

      data = await hubspotRequest(context, `/crm/v3/objects/${objectType}`, { params });
    }

    return {
      engagements: (data.results ?? []).map(formatter),
      total: data.total ?? data.results?.length ?? 0,
      hasMore: !!data.paging?.next?.after,
      nextCursor: data.paging?.next?.after ?? null,
    };
  },
};
