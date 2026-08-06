import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest, formatEngagement } from '../lib';

export const createEngagement: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a HubSpot engagement (call, email, meeting, note, task). Uses the v3 engagements API. Params: type (call|email|meeting|note|task), subject?, body?, status?, direction?, startTime?, duration?, associatedObjectType?, associatedObjectId?, properties?',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        description: 'Engagement type.',
        enum: ['call', 'email', 'meeting', 'note', 'task'],
      },
      subject: { type: 'string', description: 'Subject or title of the engagement.' },
      body: { type: 'string', description: 'Body/content of the engagement.' },
      status: { type: 'string', description: 'Status (e.g., "COMPLETED", "SCHEDULED", "NOT_STARTED").' },
      direction: { type: 'string', description: 'Direction: INBOUND or OUTBOUND (for calls/emails).' },
      startTime: { type: 'string', description: 'Start time ISO string (for meetings/calls).' },
      duration: { type: 'number', description: 'Duration in milliseconds (for calls).' },
      associatedObjectType: {
        type: 'string',
        description: 'Associated object type: contacts, companies, deals, tickets.',
        enum: ['contacts', 'companies', 'deals', 'tickets'],
      },
      associatedObjectId: { type: 'string', description: 'HubSpot ID of the associated object.' },
      properties: {
        type: 'object',
        description: 'Additional engagement properties as key-value pairs.',
      },
    },
    required: ['type'],
  },
  handler: async (args, context) => {
    const { type, subject, body, status, direction, startTime, duration, associatedObjectType, associatedObjectId, properties: extraProps } = args as {
      type: 'call' | 'email' | 'meeting' | 'note' | 'task';
      subject?: string;
      body?: string;
      status?: string;
      direction?: string;
      startTime?: string;
      duration?: number;
      associatedObjectType?: string;
      associatedObjectId?: string;
      properties?: Record<string, string>;
    };

    // Map engagement types to HubSpot object types
    const engagementTypeMap: Record<string, string> = {
      call: 'calls',
      email: 'emails',
      meeting: 'meetings',
      note: 'notes',
      task: 'tasks',
    };

    const objectType = engagementTypeMap[type];

    const properties: Record<string, string> = {
      ...(subject && { [`hs_${type}_title`]: subject, [`hs_${type}_subject`]: subject }),
      ...(body && { [`hs_${type}_body`]: body, [`hs_${type}_text`]: body, [`hs_${type}_body`]: body }),
      ...(status && { [`hs_${type}_status`]: status }),
      ...(direction && { [`hs_${type}_direction`]: direction }),
      ...(startTime && { hs_timestamp: String(new Date(startTime).getTime()) }),
      ...(duration !== undefined && { [`hs_${type}_duration`]: String(duration) }),
      ...extraProps,
    };

    // Normalize property keys based on type
    const payload: Record<string, any> = { properties };

    if (type === 'email') {
      if (subject) payload.properties.hs_email_subject = subject;
      if (body) payload.properties.hs_email_text = body;
      if (status) payload.properties.hs_email_status = status;
      if (direction) payload.properties.hs_email_direction = direction;
    } else if (type === 'call') {
      if (subject) payload.properties.hs_call_title = subject;
      if (body) payload.properties.hs_call_body = body;
      if (status) payload.properties.hs_call_status = status;
      if (direction) payload.properties.hs_call_direction = direction;
      if (duration !== undefined) payload.properties.hs_call_duration = String(duration);
    } else if (type === 'meeting') {
      if (subject) payload.properties.hs_meeting_title = subject;
      if (body) payload.properties.hs_meeting_body = body;
      if (status) payload.properties.hs_meeting_status = status;
      if (startTime) payload.properties.hs_meeting_start_time = startTime;
    } else if (type === 'note') {
      if (body) payload.properties.hs_note_body = body;
    } else if (type === 'task') {
      if (subject) payload.properties.hs_task_subject = subject;
      if (body) payload.properties.hs_task_body = body;
      if (status) payload.properties.hs_task_status = status;
      if (startTime) payload.properties.hs_timestamp = String(new Date(startTime).getTime());
    }

    const data = (await hubspotRequest(context, `/crm/v3/objects/${objectType}`, {
      method: 'POST',
      body: payload,
    })) as any;

    // If associations were requested, create them
    if (associatedObjectType && associatedObjectId) {
      try {
        await hubspotRequest(
          context,
          `/crm/v4/associations/${objectType}/${associatedObjectType}/batch/create`,
          {
            method: 'POST',
            body: {
              inputs: [
                {
                  from: { id: data.id },
                  to: { id: associatedObjectId },
                  types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 1 }],
                },
              ],
            },
          },
        );
      } catch {
        // Association creation is best-effort
      }
    }

    return formatEngagement(data);
  },
};
