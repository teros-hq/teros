import type { ToolConfig } from '@teros/mca-sdk';
import { buildProperties, hubspotRequest, formatTicket } from '../lib';

export const updateTicket: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Update an existing HubSpot ticket. Idempotent per-field — safe to retry. Params: ticketId, subject?, content?, status?, priority?, category?, pipeline?, stage?, source?, properties?',
  parameters: {
    type: 'object',
    properties: {
      ticketId: { type: 'string', description: 'HubSpot ticket ID.' },
      subject: { type: 'string', description: 'Ticket subject.' },
      content: { type: 'string', description: 'Ticket content.' },
      status: { type: 'string', description: 'Ticket status.' },
      priority: { type: 'string', description: 'Ticket priority.' },
      category: { type: 'string', description: 'Ticket category.' },
      pipeline: { type: 'string', description: 'Pipeline ID.' },
      stage: { type: 'string', description: 'Pipeline stage ID.' },
      source: { type: 'string', description: 'Ticket source.' },
      properties: {
        type: 'object',
        description: 'Additional HubSpot ticket properties as key-value pairs.',
      },
    },
    required: ['ticketId'],
  },
  handler: async (args, context) => {
    const { ticketId, subject, content, status, priority, category, pipeline, stage, source, properties: extraProps } = args as {
      ticketId: string;
      subject?: string;
      content?: string;
      status?: string;
      priority?: string;
      category?: string;
      pipeline?: string;
      stage?: string;
      source?: string;
      properties?: Record<string, string>;
    };

    const payload: Record<string, any> = {
      ...(subject && { subject }),
      ...(content && { content }),
      ...(status && { hs_ticket_priority: status }),
      ...(priority && { hs_pipeline_stage: priority }),
      ...(category && { hs_ticket_category: category }),
      ...(pipeline && { hs_pipeline: pipeline }),
      ...(stage && { hs_pipeline_stage: stage }),
      ...(source && { source_type: source }),
      ...extraProps,
    };

    const data = (await hubspotRequest(context, `/crm/v3/objects/tickets/${encodeURIComponent(ticketId)}`, {
      method: 'PATCH',
      body: buildProperties(payload),
    })) as any;

    return formatTicket(data);
  },
};
