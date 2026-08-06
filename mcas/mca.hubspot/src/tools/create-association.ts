import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest, formatAssociation } from '../lib';

export const createAssociation: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create an association between two HubSpot CRM objects (e.g., contact-company, deal-contact). Uses v4 associations API. Params: fromObjectType, fromObjectId, toObjectType, toObjectId, associationType?',
  parameters: {
    type: 'object',
    properties: {
      fromObjectType: {
        type: 'string',
        description: 'Source object type: contacts, companies, deals, tickets.',
        enum: ['contacts', 'companies', 'deals', 'tickets'],
      },
      fromObjectId: { type: 'string', description: 'Source object HubSpot ID.' },
      toObjectType: {
        type: 'string',
        description: 'Target object type: contacts, companies, deals, tickets.',
        enum: ['contacts', 'companies', 'deals', 'tickets'],
      },
      toObjectId: { type: 'string', description: 'Target object HubSpot ID.' },
      associationType: {
        type: 'string',
        description: 'Association type ID or label (e.g., "contact_to_company", "deal_to_contact"). Optional — HubSpot will use default if omitted.',
      },
    },
    required: ['fromObjectType', 'fromObjectId', 'toObjectType', 'toObjectId'],
  },
  handler: async (args, context) => {
    const { fromObjectType, fromObjectId, toObjectType, toObjectId, associationType } = args as {
      fromObjectType: string;
      fromObjectId: string;
      toObjectType: string;
      toObjectId: string;
      associationType?: string;
    };

    const body: Record<string, any> = {
      inputs: [
        {
          from: { id: fromObjectId },
          to: { id: toObjectId },
          types: associationType
            ? [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: associationType }]
            : [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 1 }],
        },
      ],
    };

    const data = (await hubspotRequest(
      context,
      `/crm/v4/associations/${fromObjectType}/${toObjectType}/batch/create`,
      { method: 'POST', body },
    )) as any;

    return {
      associations: (data.results ?? []).map(formatAssociation),
      success: true,
    };
  },
};
