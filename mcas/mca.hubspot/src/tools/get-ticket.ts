import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest, formatTicket } from '../lib';

export const getTicket: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Retrieve a HubSpot ticket by ID. Returns curated { id, subject, content, status, priority, category, pipeline, stage, source, createdAt, updatedAt }. Params: ticketId',
  parameters: {
    type: 'object',
    properties: {
      ticketId: { type: 'string', description: 'HubSpot ticket ID.' },
      properties: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional properties to include.',
      },
    },
    required: ['ticketId'],
  },
  handler: async (args, context) => {
    const { ticketId, properties } = args as {
      ticketId: string;
      properties?: string[];
    };

    const defaultProps = ['subject', 'content', 'hs_ticket_priority', 'hs_pipeline_stage', 'hs_ticket_category', 'hs_pipeline', 'source_type', 'createdate', 'hs_lastmodifieddate'];
    const allProps = properties ? [...new Set([...defaultProps, ...properties])] : defaultProps;

    const data = (await hubspotRequest(context, `/crm/v3/objects/tickets/${encodeURIComponent(ticketId)}`, {
      params: { properties: allProps.join(',') },
    })) as any;

    return formatTicket(data);
  },
};
