import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest, formatCompany } from '../lib';

export const getCompany: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Retrieve a HubSpot company by ID or domain. Returns curated { id, name, domain, industry, type, phone, website, city, state, country, numberOfEmployees, annualRevenue, lifecycleStage, createdAt, updatedAt }. Params: companyId, idProperty?',
  parameters: {
    type: 'object',
    properties: {
      companyId: { type: 'string', description: 'Company ID (HubSpot ID) or domain if idProperty=domain.' },
      idProperty: { type: 'string', description: 'Identifier type: "domain" to lookup by domain name. Default uses HubSpot ID.' },
      properties: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional properties to include.',
      },
    },
    required: ['companyId'],
  },
  handler: async (args, context) => {
    const { companyId, idProperty, properties } = args as {
      companyId: string;
      idProperty?: string;
      properties?: string[];
    };

    const defaultProps = ['name', 'domain', 'industry', 'type', 'phone', 'website', 'city', 'state', 'country', 'numberofemployees', 'annualrevenue', 'lifecyclestage', 'createdate', 'hs_lastmodifieddate'];
    const allProps = properties ? [...new Set([...defaultProps, ...properties])] : defaultProps;

    const params: Record<string, any> = { properties: allProps.join(',') };
    if (idProperty) params.idProperty = idProperty;

    const data = (await hubspotRequest(context, `/crm/v3/objects/companies/${encodeURIComponent(companyId)}`, { params })) as any;
    return formatCompany(data);
  },
};
