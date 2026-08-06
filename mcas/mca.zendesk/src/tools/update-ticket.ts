import type { ToolConfig } from '@teros/mca-sdk';
import { zendeskRequest } from '../lib';

export const updateTicket: ToolConfig = {
  description:
    'Update an existing Zendesk ticket. Only provided fields are changed. Returns the updated ticket. Params: ticketId, subject?, description?, priority?, status?, assigneeId?, tags?, customFields?.',
  parameters: {
    type: 'object',
    properties: {
      ticketId: {
        type: 'string',
        description: 'Zendesk ticket ID to update.',
      },
      subject: {
        type: 'string',
        description: 'New subject line.',
      },
      description: {
        type: 'string',
        description: 'New comment/description to add.',
      },
      priority: {
        type: 'string',
        enum: ['urgent', 'high', 'normal', 'low'],
        description: 'New priority.',
      },
      status: {
        type: 'string',
        enum: ['new', 'open', 'pending', 'hold', 'solved', 'closed'],
        description: 'New status.',
      },
      assigneeId: {
        type: 'string',
        description: 'User ID to assign the ticket to.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Replace existing tags with these.',
      },
      customFields: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            value: {},
          },
        },
        description: 'Custom field values [{id, value}].',
      },
    },
    required: ['ticketId'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const {
      ticketId,
      subject,
      description,
      priority,
      status,
      assigneeId,
      tags,
      customFields,
    } = args as {
      ticketId: string;
      subject?: string;
      description?: string;
      priority?: string;
      status?: string;
      assigneeId?: string;
      tags?: string[];
      customFields?: Array<{ id: number; value: unknown }>;
    };

    const ticket: Record<string, unknown> = {};

    if (subject) ticket.subject = subject;
    if (description) ticket.comment = { body: description };
    if (priority) ticket.priority = priority;
    if (status) ticket.status = status;
    if (assigneeId) ticket.assignee_id = Number(assigneeId);
    if (tags) ticket.tags = tags;
    if (customFields) ticket.custom_fields = customFields;

    const result = (await zendeskRequest(context, `/tickets/${ticketId}.json`, {
      method: 'PUT',
      body: { ticket },
    })) as any;

    const t = result.ticket;
    return {
      id: t.id,
      subject: t.subject,
      status: t.status,
      priority: t.priority,
      assigneeId: t.assignee_id,
      updatedAt: t.updated_at,
      url: t.url,
    };
  },
};
