import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest, formatContact } from '../lib';

export const getContact: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Retrieve a HubSpot contact by ID or email. Returns curated { id, email, firstName, lastName, phone, company, jobTitle, website, lifecycleStage, leadStatus, createdAt, updatedAt }. Params: contactId, idProperty?',
  parameters: {
    type: 'object',
    properties: {
      contactId: { type: 'string', description: 'Contact ID (HubSpot ID) or email if idProperty=email.' },
      idProperty: { type: 'string', description: 'Identifier type: "email" to lookup by email address. Default uses HubSpot ID.' },
      properties: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional properties to include.',
      },
    },
    required: ['contactId'],
  },
  handler: async (args, context) => {
    const { contactId, idProperty, properties } = args as {
      contactId: string;
      idProperty?: string;
      properties?: string[];
    };

    const defaultProps = ['email', 'firstname', 'lastname', 'phone', 'company', 'jobtitle', 'website', 'lifecyclestage', 'hs_lead_status', 'createdate', 'lastmodifieddate'];
    const allProps = properties ? [...new Set([...defaultProps, ...properties])] : defaultProps;

    const params: Record<string, any> = { properties: allProps.join(',') };
    if (idProperty) params.idProperty = idProperty;

    const data = (await hubspotRequest(context, `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, { params })) as any;
    return formatContact(data);
  },
};
