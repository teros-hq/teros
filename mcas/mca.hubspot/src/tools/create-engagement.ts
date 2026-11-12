import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest, resolveAssociationTypeId, formatEngagement, formatTask } from '../lib';

// hs_email_direction allowed options changed on HubSpot's side (verified live
// 2026-10-27, bug fb_7e877154a68782de): OUTBOUND/INBOUND now return
// INVALID_OPTION — "OUTBOUND was not one of the allowed options:
// [FORWARDED_EMAIL, INCOMING_EMAIL, EMAIL, DRAFT_EMAIL]". Map the legacy
// values so existing callers keep working; anything else passes through
// unchanged (HubSpot validates the rest).
const EMAIL_DIRECTION_LEGACY_MAP: Record<string, string> = {
  OUTBOUND: 'EMAIL',
  INBOUND: 'INCOMING_EMAIL',
};

function EMAIL_DIRECTION_MAP(direction: string): string {
  return EMAIL_DIRECTION_LEGACY_MAP[direction.toUpperCase()] ?? direction;
}

export const createEngagement: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a HubSpot engagement (call, email, meeting, note, task). Uses the v3 engagements API. Params: type (call|email|meeting|note|task), subject?, body?, status?, direction?, startTime?, duration?, associatedObjectType?, associatedObjectId?, properties?. startTime is optional — if omitted, the current time is used as the engagement timestamp.',
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
      direction: {
        type: 'string',
        description:
          'Direction. For calls: INBOUND or OUTBOUND. For emails: EMAIL (outgoing), INCOMING_EMAIL, FORWARDED_EMAIL or DRAFT_EMAIL (legacy INBOUND/OUTBOUND are mapped automatically).',
      },
      startTime: {
        type: 'string',
        description:
          'Engagement timestamp / due date, ISO string. Optional — defaults to now. HubSpot requires hs_timestamp on every engagement type.',
      },
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

    // Build the payload with the real HubSpot property names per type.
    // The previous generic block produced keys like `hs_task_title` /
    // `hs_task_text` / `hs_task_direction` that HubSpot rejects with
    // PROPERTY_DOESNT_EXIST (HTTP 400), so creating tasks with subject+body
    // failed outright.
    const properties: Record<string, string> = { ...(extraProps ?? {}) };

    // HubSpot requires `hs_timestamp` on every engagement type (notes, tasks,
    // calls, emails, meetings — verified live 2026-10-27, bug fb_7e877154a68782de).
    // Without it the API rejects the create with 400 "Some required properties
    // were not set". It is set from startTime when given, else defaults to now.
    // An explicit hs_timestamp in `properties` (backdating) wins over both.
    if (properties.hs_timestamp === undefined) {
      const timestampMs = startTime ? new Date(startTime).getTime() : Date.now();
      if (!Number.isNaN(timestampMs)) {
        properties.hs_timestamp = String(timestampMs);
      }
    }

    if (type === 'email') {
      if (subject) properties.hs_email_subject = subject;
      if (body) properties.hs_email_text = body;
      if (status) properties.hs_email_status = status;
      if (direction) {
        // hs_email_direction changed its allowed options (verified live
        // 2026-10-27): OUTBOUND/INBOUND are no longer accepted — the API now
        // wants EMAIL / INCOMING_EMAIL / FORWARDED_EMAIL / DRAFT_EMAIL. Map
        // the legacy values so existing callers keep working.
        properties.hs_email_direction = EMAIL_DIRECTION_MAP(direction);
      }
    } else if (type === 'call') {
      if (subject) properties.hs_call_title = subject;
      if (body) properties.hs_call_body = body;
      if (status) properties.hs_call_status = status;
      if (direction) properties.hs_call_direction = direction;
      if (duration !== undefined) properties.hs_call_duration = String(duration);
    } else if (type === 'meeting') {
      if (subject) properties.hs_meeting_title = subject;
      if (body) properties.hs_meeting_body = body;
      if (status) properties.hs_meeting_status = status;
      if (startTime) {
        properties.hs_meeting_start_time = startTime;
      }
    } else if (type === 'note') {
      if (body) properties.hs_note_body = body;
    } else if (type === 'task') {
      if (subject) properties.hs_task_subject = subject;
      if (body) properties.hs_task_body = body;
      if (status) properties.hs_task_status = status;
    }

    const payload: Record<string, any> = { properties };

    const data = (await hubspotRequest(context, `/crm/v3/objects/${objectType}`, {
      method: 'POST',
      body: payload,
    })) as any;

    // If associations were requested, create them with the pair's real
    // HUBSPOT_DEFINED typeId. The old code hardcoded typeId 1 (contact→
    // primary company) for every pair — invalid for engagement→object pairs,
    // which HubSpot rejects with HTTP 400 — and swallowed the failure in a
    // bare catch, so the engagement was created but left orphaned with a
    // successful-looking response (support report 2026-09-11).
    let association: { associated: boolean; associationError?: string } | undefined;

    if (associatedObjectType && associatedObjectId) {
      const typeId = resolveAssociationTypeId(objectType, associatedObjectType);

      if (typeId === undefined) {
        association = {
          associated: false,
          associationError: `No verified HUBSPOT_DEFINED association type for ${objectType} → ${associatedObjectType}. The ${type} was created but NOT associated — associate it manually with create-association.`,
        };
      } else {
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
                    types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }],
                  },
                ],
              },
            },
          );
          association = { associated: true };
        } catch (error) {
          // Surface the failure: the engagement exists but is orphaned. The
          // agent/user must know, otherwise the record is "in limbo".
          association = {
            associated: false,
            associationError: `The ${type} was created (id ${data.id}) but the association to ${associatedObjectType} ${associatedObjectId} failed: ${error instanceof Error ? error.message : String(error)}. Associate it manually with create-association.`,
          };
        }
      }
    }

    // Tasks use formatTask: formatEngagement never reads hs_task_* properties.
    const formatted = type === 'task' ? formatTask(data) : formatEngagement(data);
    return association ? { ...formatted, ...association } : formatted;
  },
};
